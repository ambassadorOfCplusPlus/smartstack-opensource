// Конфликты синхронизации и голосование (Фаза 2, S7).
//
// Два типа конфликтов (CLAUDE.md):
//  - ФИЗИЧЕСКИЙ (остаток в минус): оба списания валидны → частичное списание
//    уже выполнено в merge.service; здесь — уведомление admin+keeper
//    «нужна инвентаризация» (через инжектируемый Notifier).
//  - СМЫСЛОВОЙ (concurrent-правки одного поля, по vector clocks): создаётся
//    ConflictVote, поле замораживается (merge отклоняет правки замороженного
//    поля), пользователи с правом products:edit голосуют. Большинство → в БД.
//    Равенство/дедлайн → решает админ. Админ может закрыть досрочно (вето).

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { Permission } from '@smartstock/shared';
import type { DomainEvents } from '../../plugins/domain-events';
import { noopDomainEvents } from '../../plugins/domain-events';
import type { VectorClock } from './types';

export class ConflictError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vector clocks: сравнение
// ─────────────────────────────────────────────────────────────────────────────

// a доминирует над b (a — потомок b): для всех компонент a[k] >= b[k].
export function dominates(a: VectorClock, b: VectorClock): boolean {
  for (const k of Object.keys(b)) {
    if ((a[k] ?? 0) < (b[k] ?? 0)) return false;
  }
  return true;
}

// Конкуррентны: никто не доминирует (правки «параллельны» — был офлайн).
export function isConcurrent(a: VectorClock, b: VectorClock): boolean {
  return !dominates(a, b) && !dominates(b, a);
}

// Вариант в голосовании: значение + происхождение.
export interface ConflictOption {
  value: unknown;
  deviceId: string | null;
  userId: string | null;
  vectorClock: VectorClock | null;
}

// Минимальный интерфейс уведомлений (NotificationService совместим).
export interface ConflictNotifier {
  notify(
    userId: string,
    type: string,
    title: string,
    body: string,
    payload?: unknown,
  ): Promise<unknown>;
}

export interface ConflictServiceDeps {
  prisma: PrismaClient;
  events?: DomainEvents;
  notifier?: ConflictNotifier;
  // Дедлайн голосования по умолчанию, часов.
  defaultDeadlineHours?: number;
}

export class ConflictService {
  private readonly prisma: PrismaClient;
  private readonly events: DomainEvents;
  private readonly notifier?: ConflictNotifier;
  private readonly deadlineHours: number;

  constructor(deps: ConflictServiceDeps) {
    this.prisma = deps.prisma;
    this.events = deps.events ?? noopDomainEvents;
    this.notifier = deps.notifier;
    this.deadlineHours = deps.defaultDeadlineHours ?? 24;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Заморозка: поле считается замороженным, пока по нему есть open-голосование.
  // ───────────────────────────────────────────────────────────────────────────
  async findOpenVote(entityType: string, entityId: string, field: string) {
    const open = await this.prisma.conflictVote.findMany({
      where: { entityType, entityId, field, status: 'open' },
    });
    return open[0] ?? null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Смысловой конфликт: создать голосование + заморозить поле + оповестить.
  // optionA — текущее серверное значение, optionB — входящее (конкуррентное).
  // ───────────────────────────────────────────────────────────────────────────
  async openSemanticConflict(params: {
    orgId: string;
    entityType: string;
    entityId: string;
    field: string;
    optionA: ConflictOption;
    optionB: ConflictOption;
  }) {
    const vote = await this.prisma.conflictVote.create({
      data: {
        organizationId: params.orgId,
        entityType: params.entityType,
        entityId: params.entityId,
        field: params.field,
        optionA: params.optionA as unknown as Prisma.InputJsonValue,
        optionB: params.optionB as unknown as Prisma.InputJsonValue,
        status: 'open',
        deadline: new Date(Date.now() + this.deadlineHours * 3600_000),
      },
    });

    this.events.emit('conflict:new', {
      orgId: params.orgId,
      conflictId: vote.id,
      type: 'semantic',
      entityType: params.entityType,
      entityId: params.entityId,
      field: params.field,
    });

    // Уведомить всех потенциальных голосующих.
    if (this.notifier) {
      const voters = await this.findUsersWithPermission(params.orgId, Permission.PRODUCTS_EDIT);
      for (const uid of voters) {
        await this.notifier.notify(
          uid,
          'conflict:vote',
          'Спорная правка — нужен ваш голос',
          `Поле «${params.field}» изменено на двух ПК одновременно. Выберите верный вариант.`,
          { conflictId: vote.id },
        );
      }
    }

    return vote;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Физический конфликт: уведомление admin + keeper «нужна инвентаризация».
  // (Списание уже применено частично в merge; недостача = shortage.)
  // ───────────────────────────────────────────────────────────────────────────
  async notifyPhysicalShortage(params: {
    orgId: string;
    productId: string;
    productName: string;
    warehouseId: string | null;
    shortage: number;
  }): Promise<void> {
    this.events.emit('conflict:new', {
      orgId: params.orgId,
      conflictId: null,
      type: 'physical',
      entityType: 'product',
      entityId: params.productId,
      field: null,
    });

    if (!this.notifier) return;
    const keepers = await this.findUsersWithPermission(params.orgId, Permission.BATCHES_WRITEOFF);
    const admins = await this.findUsersWithPermission(params.orgId, Permission.SETTINGS_MANAGE);
    // S12.2: бухгалтеры (DOCUMENTS_APPROVE) тоже должны узнать о недостаче,
    // т.к. требуется инвентаризация и сверка по журналу действий товара.
    const accountants = await this.findUsersWithPermission(
      params.orgId,
      Permission.DOCUMENTS_APPROVE,
    );
    // Подсказка клиентам: где смотреть журнал действий по товару.
    const auditTrail = `/api/v1/products/${params.productId}/audit-trail`;
    const payload = {
      productId: params.productId,
      warehouseId: params.warehouseId,
      shortage: params.shortage,
      auditTrail,
    };

    // Кладовщики и админы — общий текст «нужна инвентаризация».
    const opsTargets = [...new Set([...keepers, ...admins])];
    for (const uid of opsTargets) {
      await this.notifier.notify(
        uid,
        'conflict:physical',
        'Недостача при синхронизации — нужна инвентаризация',
        `Товар «${params.productName}»: списания с двух ПК превысили остаток на ${params.shortage}. Проведите инвентаризацию.`,
        payload,
      );
    }

    // Бухгалтеры — отдельный текст со ссылкой на журнал в карточке товара
    // (исключаем тех, кому уже отправили как кладовщику/админу).
    const accountantTargets = accountants.filter((uid) => !opsTargets.includes(uid));
    for (const uid of accountantTargets) {
      await this.notifier.notify(
        uid,
        'conflict:physical',
        'Недостача при синхронизации — требуется инвентаризация',
        `Недостача по товару «${params.productName}»: требуется инвентаризация. ` +
          'Журнал действий по товару доступен в карточке товара.',
        payload,
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Список конфликтов организации (для админки и polling десктопа).
  // ───────────────────────────────────────────────────────────────────────────
  async list(orgId: string, status?: 'open' | 'resolved' | 'cancelled') {
    const rows = await this.prisma.conflictVote.findMany({
      where: { organizationId: orgId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    const result = [];
    for (const v of rows) {
      const choices = await this.prisma.conflictVoteChoice.findMany({
        where: { conflictId: v.id },
      });
      result.push({
        id: v.id,
        entityType: v.entityType,
        entityId: v.entityId,
        field: v.field,
        optionA: v.optionA,
        optionB: v.optionB,
        status: v.status,
        resolutionMode: v.resolutionMode,
        winner: v.winner,
        deadline: v.deadline?.toISOString() ?? null,
        votes: {
          a: choices.filter((c) => c.choice === 'a').length,
          b: choices.filter((c) => c.choice === 'b').length,
        },
        myVoteHint: undefined, // заполняется на уровне роута при необходимости
        createdAt: v.createdAt.toISOString(),
        resolvedAt: v.resolvedAt?.toISOString() ?? null,
      });
    }
    return result;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Голос: один на человека (составной PK conflictId+userId).
  // Если проголосовали ВСЕ имеющие право и большинство явное — авторазрешение.
  // ───────────────────────────────────────────────────────────────────────────
  async vote(caller: { userId: string; orgId: string }, conflictId: string, choice: 'a' | 'b') {
    const conflict = await this.prisma.conflictVote.findUnique({ where: { id: conflictId } });
    if (!conflict || conflict.organizationId !== caller.orgId) {
      throw new ConflictError(404, 'NotFound', 'Голосование не найдено');
    }
    if (conflict.status !== 'open') {
      throw new ConflictError(409, 'Closed', 'Голосование уже завершено');
    }

    const existing = await this.prisma.conflictVoteChoice.findUnique({
      where: { conflictId_userId: { conflictId, userId: caller.userId } },
    });
    if (existing) {
      throw new ConflictError(409, 'AlreadyVoted', 'Вы уже проголосовали');
    }

    try {
      await this.prisma.conflictVoteChoice.create({
        data: { conflictId, userId: caller.userId, choice },
      });
    } catch (err) {
      // Гонка: два голоса одного пользователя одновременно. Составной PK
      // (conflictId,userId) → P2002. Это «уже проголосовал», а не 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError(409, 'AlreadyVoted', 'Вы уже проголосовали');
      }
      throw err;
    }

    // Авторазрешение: все правомочные проголосовали и большинство явное.
    const eligible = await this.findUsersWithPermission(caller.orgId, Permission.PRODUCTS_EDIT);
    const choices = await this.prisma.conflictVoteChoice.findMany({ where: { conflictId } });
    const a = choices.filter((c) => c.choice === 'a').length;
    const b = choices.filter((c) => c.choice === 'b').length;

    if (choices.length >= eligible.length && a !== b) {
      await this.applyResolution(conflict, a > b ? 'a' : 'b', 'majority');
      return { voted: choice, votes: { a, b }, resolved: true, winner: a > b ? 'a' : 'b' };
    }

    return { voted: choice, votes: { a, b }, resolved: false };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Решение конфликта (админ): mode 'majority' — по текущему большинству
  // (равенство → 409), mode 'veto' — выбор админа (choice обязателен).
  // ───────────────────────────────────────────────────────────────────────────
  async resolve(
    caller: { userId: string; orgId: string },
    input: { conflictId: string; mode: 'majority' | 'veto'; choice?: 'a' | 'b' },
  ) {
    const conflict = await this.prisma.conflictVote.findUnique({
      where: { id: input.conflictId },
    });
    if (!conflict || conflict.organizationId !== caller.orgId) {
      throw new ConflictError(404, 'NotFound', 'Голосование не найдено');
    }
    if (conflict.status !== 'open') {
      throw new ConflictError(409, 'Closed', 'Голосование уже завершено');
    }

    let winner: 'a' | 'b';
    if (input.mode === 'veto') {
      if (!input.choice) {
        throw new ConflictError(400, 'ChoiceRequired', 'Для вето укажите вариант (a|b)');
      }
      winner = input.choice;
    } else {
      const choices = await this.prisma.conflictVoteChoice.findMany({
        where: { conflictId: input.conflictId },
      });
      const a = choices.filter((c) => c.choice === 'a').length;
      const b = choices.filter((c) => c.choice === 'b').length;
      if (a === b) {
        throw new ConflictError(409, 'Tie', 'Равенство голосов — требуется вето админа');
      }
      winner = a > b ? 'a' : 'b';
    }

    await this.applyResolution(conflict, winner, input.mode, caller.userId);
    return { conflictId: input.conflictId, winner, mode: input.mode };
  }

  // Дедлайн (S7.6): просроченные open-голосования → уведомить админов,
  // что решение теперь за ними. Вызывается из BullMQ-воркера/cron.
  async checkDeadlines(orgId?: string): Promise<number> {
    const expired = await this.prisma.conflictVote.findMany({
      where: {
        status: 'open',
        deadline: { lt: new Date() },
        ...(orgId ? { organizationId: orgId } : {}),
      },
    });
    for (const v of expired) {
      if (!this.notifier) continue;
      const admins = await this.findUsersWithPermission(
        v.organizationId,
        Permission.SETTINGS_MANAGE,
      );
      for (const uid of admins) {
        await this.notifier.notify(
          uid,
          'conflict:deadline',
          'Голосование истекло — нужно ваше решение',
          `Спор по полю «${v.field}» не разрешён до дедлайна. Закройте голосование (большинство или вето).`,
          { conflictId: v.id },
        );
      }
    }
    return expired.length;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Внутреннее
  // ───────────────────────────────────────────────────────────────────────────

  // Применить победивший вариант к товару, закрыть голосование, audit.
  private async applyResolution(
    conflict: { id: string; organizationId: string; entityType: string; entityId: string; field: string; optionA: unknown; optionB: unknown },
    winner: 'a' | 'b',
    mode: 'majority' | 'admin' | 'veto',
    resolvedBy?: string,
  ): Promise<void> {
    const option = (winner === 'a' ? conflict.optionA : conflict.optionB) as ConflictOption;

    // Применяем значение к сущности (пока поддерживается только product).
    if (conflict.entityType === 'product') {
      const data: Record<string, unknown> = {};
      switch (conflict.field) {
        case 'price':
          data.price = new Prisma.Decimal(Number(option.value).toFixed(2));
          break;
        case 'minStock':
          data.minStock = new Prisma.Decimal(Number(option.value).toFixed(3));
          break;
        default:
          data[conflict.field] = option.value;
      }
      await this.prisma.product.update({ where: { id: conflict.entityId }, data });
    }

    await this.prisma.conflictVote.update({
      where: { id: conflict.id },
      data: {
        status: 'resolved',
        winner,
        resolutionMode: mode === 'veto' ? 'veto' : mode === 'admin' ? 'admin' : 'majority',
        resolvedAt: new Date(),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: conflict.organizationId,
        userId: resolvedBy ?? null,
        action: 'conflict:resolved',
        entity: 'conflict_vote',
        entityId: conflict.id,
        payload: { winner, mode, field: conflict.field } as Prisma.InputJsonValue,
      },
    });

    this.events.emit('conflict:resolved', {
      orgId: conflict.organizationId,
      conflictId: conflict.id,
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      field: conflict.field,
      winner,
    });
  }

  // Пользователи организации с данным правом (по ролям).
  private async findUsersWithPermission(orgId: string, permission: Permission): Promise<string[]> {
    const userRoles = await this.prisma.userRole.findMany({
      where: {},
      include: { role: true },
    });
    const out = new Set<string>();
    for (const ur of userRoles) {
      const role = ur.role as { permissions?: string[]; organizationId?: string } | null;
      if (!role?.permissions?.includes(permission)) continue;
      // Пользователь должен принадлежать организации.
      const u = await this.prisma.user.findUnique({ where: { id: ur.userId } });
      if (u && (u as { organizationId?: string }).organizationId === orgId) {
        out.add(ur.userId);
      }
    }
    return [...out];
  }
}
