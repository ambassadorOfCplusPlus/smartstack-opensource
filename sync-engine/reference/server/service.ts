// Сервис приёма операций синхронизации (Фаза 2, S5.1).
//
// POST /sync/push: для каждой операции ПО ПОРЯДКУ —
//  1. идемпотентность: SyncOperation с таким id уже есть → НЕ применять повторно,
//     вернуть в accepted с её серверным статусом;
//  2. валидация (operationSchema) + проверка доступа (склад/товар своей орг.) —
//     невалидная/чужая → rejected, остальные продолжают;
//  3. применить в ОТДЕЛЬНОЙ транзакции (атомарность операции) через merge.service;
//  4. записать SyncOperation (id с десктопа, status, serverSeq autoincrement).
//
// Весь push НЕ в одной мега-транзакции — по операции за раз (частичный успех
// допустим). Это требование S5.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import type { DomainEvents } from '../../plugins/domain-events';
import { ConflictService, isConcurrent, dominates, type ConflictNotifier } from './conflict.service';
import { operationSchema, type ValidatedOperation } from './schema';
import {
  applyBatchReceipt,
  applyBatchWriteoff,
  applyProductUpdate,
  type MergeOutcome,
} from './merge.service';
import type {
  AcceptedEntry,
  ConflictEntry,
  RejectedEntry,
  PushResult,
  PullResult,
  PulledOperation,
  SnapshotResult,
  BatchReceiptPayload,
  BatchWriteoffPayload,
  ProductUpdatePayload,
  SyncEntityType,
  SyncOperationKind,
  SyncPayload,
  VectorClock,
} from './types';

export interface SyncServiceDeps {
  prisma: PrismaClient;
  // S7: события (conflict:new/resolved → WS) и уведомления (admin/keeper/голосующие).
  events?: DomainEvents;
  notifier?: ConflictNotifier;
  // «Окно безопасности» pull, мс — ЭВРИСТИКА (best-effort), не гарантия.
  // serverSeq (autoincrement) присваивается при INSERT, а строка видна только на
  // COMMIT — под конкуренцией более ранний seq может закоммититься ПОЗЖЕ соседа с
  // бóльшим seq, и курсор since пропустил бы его навсегда. Отдаём только записи,
  // у которых receivedAt (ВРЕМЯ СТАРТА транзакции — Postgres now()) старше окна.
  // ВАЖНО: окно надёжно лишь если транзакция КОММИТИТСЯ быстрее окна (старт+commit
  // в пределах pullSafetyMs); транзакция, живущая дольше окна, его обходит.
  // Транзакции тут короткие (Serializable writeoff/transfer/sale), 0 — выкл
  // (dev/тесты), в проде ~3000. Гарантированно gap-free курсор потребовал бы
  // порядка по времени КОММИТА (txid/commit-ts), это отдельная доработка.
  pullSafetyMs?: number;
}

export interface SyncCaller {
  userId: string;
  orgId: string;
  deviceId: string;
}

// Ошибка доступа/валидации, ведущая к rejected (не бросается наружу).
class OperationRejected extends Error {}

// Ошибка доступа для GET-эндпоинтов (pull/snapshot) → HTTP 404.
export class SyncNotFound extends Error {}

// Устройство заблокировано администратором → HTTP 403 {error:'DeviceBlocked'}.
export class DeviceBlocked extends Error {
  constructor() {
    super('Устройство заблокировано администратором');
    this.name = 'DeviceBlocked';
  }
}

export class SyncService {
  private readonly prisma: PrismaClient;
  private readonly pullSafetyMs: number;
  // Один раз логируем недоступность xmin-горизонта (fake-prisma/не Postgres),
  // чтобы не спамить warn на каждый pull.
  private safeHorizonWarned = false;
  readonly conflicts: ConflictService;

  constructor(deps: SyncServiceDeps) {
    this.prisma = deps.prisma;
    this.pullSafetyMs = deps.pullSafetyMs ?? 0;
    this.conflicts = new ConflictService({
      prisma: deps.prisma,
      events: deps.events,
      notifier: deps.notifier,
    });
  }

  // Принуждение блокировки устройства. Неизвестное устройство (нет записи или
  // чужая орг.) → НЕ блокируем (поведение как раньше). Заблокированное → 403.
  private async assertDeviceNotBlocked(orgId: string, deviceId: string): Promise<void> {
    let device: { organizationId: string; isBlocked?: boolean } | null = null;
    try {
      device = (await this.prisma.device.findUnique({
        where: { id: deviceId },
      })) as { organizationId: string; isBlocked?: boolean } | null;
    } catch {
      // Модель device недоступна (например, в изолированных тестах) — не блокируем.
      return;
    }
    if (!device || device.organizationId !== orgId) return;
    if (device.isBlocked) {
      throw new DeviceBlocked();
    }
  }

  async push(caller: SyncCaller, rawOperations: unknown[]): Promise<PushResult> {
    await this.assertDeviceNotBlocked(caller.orgId, caller.deviceId);

    const accepted: AcceptedEntry[] = [];
    const conflicts: ConflictEntry[] = [];
    const rejected: RejectedEntry[] = [];
    let maxServerSeq = 0n;

    for (const raw of rawOperations) {
      // id нужен для отчёта даже при ошибке — достаём «осторожно».
      const rawId =
        raw && typeof raw === 'object' && 'id' in raw
          ? String((raw as { id: unknown }).id)
          : 'unknown';

      try {
        const op = operationSchema.parse(raw);

        // 1. Идемпотентность: уже принимали эту операцию?
        const known = await this.prisma.syncOperation.findUnique({
          where: { id: op.id },
        });
        if (known) {
          const seq = this.classifyKnown(known, op.id, accepted, conflicts, rejected);
          if (seq > maxServerSeq) maxServerSeq = seq;
          continue;
        }

        // 2. Проверка доступа: задействованные склад/товар принадлежат орг.
        await this.assertOrgAccess(caller.orgId, op);

        // 2.5 (S7.3): vector clocks — конкуррентная или устаревшая правка поля.
        if (op.operation === 'product_update') {
          const verdict = await this.classifyProductUpdate(caller, op);
          if (verdict.kind === 'concurrent') {
            // Открыто голосование; операция записана со статусом conflict.
            if (verdict.serverSeq > maxServerSeq) maxServerSeq = verdict.serverSeq;
            conflicts.push({
              id: op.id,
              type: 'semantic',
              detail: { conflictId: verdict.conflictId, field: verdict.field },
            });
            continue;
          }
          if (verdict.kind === 'stale') {
            // Правка устарела (хранимая доминирует): не применяем, но принимаем
            // идемпотентно — десктоп получит актуальное значение по pull.
            const rec = await this.recordOnly(caller, op, 'accepted');
            if (rec.serverSeq > maxServerSeq) maxServerSeq = rec.serverSeq;
            accepted.push({ id: op.id, serverSeq: rec.serverSeq.toString(), status: 'accepted' });
            continue;
          }
          // verdict.kind === 'apply' → обычный путь ниже.
        }

        // 3. Применить в отдельной транзакции (атомарно для операции).
        const outcome = await this.applyAndRecord(caller, op);

        const seqStr = outcome.serverSeq.toString();
        if (outcome.serverSeq > maxServerSeq) maxServerSeq = outcome.serverSeq;

        if (outcome.merge.kind === 'conflict') {
          conflicts.push({
            id: op.id,
            type: 'physical',
            detail: {
              shortage: outcome.merge.shortage,
              requested: outcome.merge.requested,
              available: outcome.merge.available,
            },
          });
          // S7.2: уведомление admin+keeper о недостаче (вне транзакции).
          await this.notifyShortage(caller.orgId, op, outcome.merge.shortage);
        } else if (outcome.merge.kind === 'frozen') {
          // Поле заморожено идущим голосованием.
          conflicts.push({
            id: op.id,
            type: 'semantic',
            detail: { conflictId: outcome.merge.conflictId, frozen: true },
          });
        } else {
          // applied или skipped (идемпотентный скип партии) → accepted.
          accepted.push({ id: op.id, serverSeq: seqStr, status: 'accepted' });
        }
      } catch (err) {
        // Конкурентный дубль: тот же id уже создан параллельным push'ем
        // (гонка между findUnique и create). P2002 на уникальном id ⇒ операция
        // уже принята — НЕ rejected, а идемпотентный повтор. Перечитываем запись
        // и возвращаем её фактический статус/serverSeq.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const known = await this.prisma.syncOperation.findUnique({ where: { id: rawId } });
          if (known) {
            const seq = this.classifyKnown(known, rawId, accepted, conflicts, rejected);
            if (seq > maxServerSeq) maxServerSeq = seq;
            continue;
          }
        }
        if (err instanceof ZodError) {
          rejected.push({ id: rawId, error: 'validation: ' + err.issues.map((i) => i.message).join('; ') });
        } else if (err instanceof OperationRejected) {
          rejected.push({ id: rawId, error: err.message });
        } else {
          rejected.push({ id: rawId, error: (err as Error).message });
        }
      }
    }

    return {
      accepted,
      conflicts,
      rejected,
      maxServerSeq: maxServerSeq.toString(),
    };
  }

  // Применить операцию к мастер-БД и записать SyncOperation в ОДНОЙ транзакции.
  //
  // ВАЖНО (frozen): операция, попавшая в замороженное голосованием поле, НЕ
  // записывается в sync_operations как терминальная. Иначе при идемпотентном
  // повторе (десктоп шлёт пачку снова ПОСЛЕ resolve) она нашлась бы как
  // known/accepted и вернулась бы accepted БЕЗ повторного применения — правка
  // потерялась бы навсегда. Не записывая её, мы даём десктопу повторить push
  // после разморозки: тогда операция переоценивается заново (apply / stale /
  // снова concurrent → новое голосование). serverSeq для frozen не нужен (в
  // accepted/conflicts она не попадает).
  private async applyAndRecord(
    caller: SyncCaller,
    op: ValidatedOperation,
  ): Promise<{ merge: MergeOutcome; serverSeq: bigint }> {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      let merge: MergeOutcome;
      let warehouseId: string | null = null;

      switch (op.operation) {
        case 'batch_receipt': {
          const p = op.payload as BatchReceiptPayload;
          warehouseId = p.warehouseId;
          merge = await applyBatchReceipt(tx, op.entityId, p);
          break;
        }
        case 'batch_writeoff': {
          const p = op.payload as BatchWriteoffPayload;
          warehouseId = p.warehouseId;
          merge = await applyBatchWriteoff(tx, p, caller.userId);
          break;
        }
        case 'product_update': {
          const p = op.payload as ProductUpdatePayload;
          merge = await applyProductUpdate(tx, op.entityId, p);
          break;
        }
      }

      // frozen: НЕ записываем операцию (см. комментарий выше) — десктоп повторит
      // после resolve. serverSeq = 0n (не используется для frozen-ветки).
      if (merge.kind === 'frozen') {
        return { merge, serverSeq: 0n };
      }

      const status = merge.kind === 'conflict' ? 'conflict' : 'accepted';

      const record = await tx.syncOperation.create({
        data: {
          id: op.id,
          organizationId: caller.orgId,
          deviceId: caller.deviceId,
          userId: caller.userId,
          warehouseId,
          entityType: op.entityType,
          entityId: op.entityId,
          operation: op.operation,
          payload: op.payload as Prisma.InputJsonValue,
          vectorClock: op.vectorClock as Prisma.InputJsonValue,
          status,
          createdAt: new Date(op.createdAt),
        },
      });

      return { merge, serverSeq: record.serverSeq };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // КОРРЕКТНЫЙ safe-horizon курсора (gap-free) через системный столбец xmin.
  //
  // serverSeq (autoincrement) присваивается при INSERT, но строка становится
  // ВИДНОЙ только на COMMIT. Под конкуренцией строка с МЕНЬШИМ seq может
  // закоммититься ПОЗЖЕ соседа с бóльшим seq — курсор `serverSeq > since`
  // перепрыгнул бы её навсегда. Чтобы этого не случилось, отдаём только строки,
  // видимые ВСЕМ активным транзакциям: их xmin старше горизонта снапшота
  // (pg_snapshot_xmin текущего снапшота) → ни одна in-flight tx уже не вставит
  // позже видимую строку с меньшим/равным seq. Возвращаем max(server_seq) среди
  // таких строк (потолок для pull/snapshot) либо null (нет видимых строк).
  //
  // Сравнение возраста xid через age() — иммунно к wraparound. На fake-prisma /
  // не-Postgres $queryRaw отсутствует → метод бросит, вызывающий сделает
  // graceful fallback на прежнее поведение (окно pullSafetyMs).
  //
  // ВАЖНО: pg_snapshot_xmin(pg_current_snapshot()) возвращает xid8 (64-бит
  // FullTransactionId), а age() принимает только xid (32-бит) → без каста PG
  // бросает `function age(xid8) does not exist` и горизонт МОЛЧА деградирует в
  // fallback (баг найден live-тестом, fake-prisma его не ловит). Каст
  // ::text::xid усекает xid8 до 32-бит xid — корректно для age()/wraparound.
  // ───────────────────────────────────────────────────────────────────────────
  private async safeHorizonSeq(orgId: string): Promise<bigint | null> {
    const rows = await this.prisma.$queryRaw<{ seq: string | null }[]>(
      Prisma.sql`
        SELECT max(server_seq)::text AS seq FROM sync_operations
        WHERE organization_id = ${orgId}::uuid AND status = 'accepted'
          AND age(xmin) > age(pg_snapshot_xmin(pg_current_snapshot())::text::xid)
      `,
    );
    const seq = rows[0]?.seq;
    return seq == null ? null : BigInt(seq);
  }

  // Обёртка над safeHorizonSeq с graceful fallback: при ошибке (нет $queryRaw в
  // тестах / не Postgres) — один warn и null (вызывающий применит прежнее окно).
  private async safeHorizonOrFallback(orgId: string): Promise<bigint | null> {
    try {
      return await this.safeHorizonSeq(orgId);
    } catch (err) {
      if (!this.safeHorizonWarned) {
        this.safeHorizonWarned = true;
        // eslint-disable-next-line no-console
        console.warn(
          'sync: xmin safe-horizon недоступен, fallback на pullSafetyMs-окно:',
          (err as Error).message,
        );
      }
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // S6.1: отдать чужие операции (serverSeq > since, НЕ от этого устройства).
  // Только accepted: conflict/rejected на других ПК не воспроизводятся
  // (их разбор — этап S7).
  // ───────────────────────────────────────────────────────────────────────────
  async pull(
    orgId: string,
    deviceId: string,
    since: bigint,
    limit: number,
  ): Promise<PullResult> {
    await this.assertDeviceNotBlocked(orgId, deviceId);

    // limit+1 — чтобы узнать, есть ли ещё страница, без отдельного count.
    // Gap-free: ограничиваем выдачу КОРРЕКТНЫМ xmin-горизонтом (видимые всем
    // активным транзакциям строки) — курсор `serverSeq > since` тогда никогда не
    // перепрыгнет невидимую операцию с меньшим seq. Если горизонт недоступен
    // (fake-prisma/не Postgres) — graceful fallback на прежнее эвристическое
    // окно pullSafetyMs (по receivedAt).
    const where: Prisma.SyncOperationWhereInput = {
      organizationId: orgId,
      serverSeq: { gt: since },
      deviceId: { not: deviceId },
      status: 'accepted',
    };
    const horizon = await this.safeHorizonOrFallback(orgId);
    if (horizon !== null) {
      where.serverSeq = { gt: since, lte: horizon };
    } else if (this.pullSafetyMs > 0) {
      where.receivedAt = { lte: new Date(Date.now() - this.pullSafetyMs) };
    }
    const rows = await this.prisma.syncOperation.findMany({
      where,
      orderBy: { serverSeq: 'asc' },
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const operations: PulledOperation[] = page.map((o) => ({
      id: o.id,
      deviceId: o.deviceId,
      entityType: o.entityType as SyncEntityType,
      entityId: o.entityId,
      operation: o.operation as SyncOperationKind,
      payload: o.payload as unknown as SyncPayload,
      vectorClock: o.vectorClock as unknown as VectorClock,
      serverSeq: o.serverSeq.toString(),
      createdAt: o.createdAt.toISOString(),
    }));

    // Ретеншн (Block 3): запомнить максимальный вытянутый serverSeq устройства.
    // Fire-and-forget внутри той же функции — ошибки логируем, pull не валим.
    if (page.length > 0) {
      const maxSeq = page[page.length - 1].serverSeq;
      await this.bumpLastPulledSeq(orgId, deviceId, maxSeq);
    }

    return {
      operations,
      maxServerSeq: page.length
        ? page[page.length - 1].serverSeq.toString()
        : since.toString(),
      hasMore,
    };
  }

  // Обновить Device.lastPulledSeq = max(текущий, maxSeq) для устройства.
  // Не бросает наружу (best-effort): провал ретеншн-учёта не должен валить pull.
  private async bumpLastPulledSeq(
    orgId: string,
    deviceId: string,
    maxSeq: bigint,
  ): Promise<void> {
    try {
      const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
      if (!device || device.organizationId !== orgId) return;
      const current = (device as { lastPulledSeq?: bigint }).lastPulledSeq ?? 0n;
      if (maxSeq > current) {
        await this.prisma.device.update({
          where: { id: deviceId },
          data: { lastPulledSeq: maxSeq },
        });
      }
    } catch {
      // best-effort: глотаем (логирование на уровне роутов не нужно).
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // S6.2: полный снимок склада для первой синхронизации нового ПК.
  // products — все активные товары организации; batches — активные партии склада;
  // lastSeq — текущий максимум serverSeq организации (точка старта pull).
  // ───────────────────────────────────────────────────────────────────────────
  async snapshot(orgId: string, warehouseId: string): Promise<SnapshotResult> {
    const wh = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!wh || wh.organizationId !== orgId) {
      throw new SyncNotFound('Склад не найден');
    }

    // Курсор старта pull (lastSeq). Применяем тот же gap-free горизонт, что и
    // pull: иначе lastSeq=MAX мог бы перепрыгнуть через операцию с меньшим
    // serverSeq, ещё не видимую всем транзакциям, и десктоп пропустил бы её
    // навсегда. Горизонт недоступен (fake/не Postgres) → fallback на окно.
    const horizon = await this.safeHorizonOrFallback(orgId);
    const [products, batches, cells, agg] = await Promise.all([
      this.prisma.product.findMany({
        where: { organizationId: orgId, isActive: true },
      }),
      this.prisma.batch.findMany({
        where: { warehouseId, status: 'active' },
      }),
      this.prisma.cell.findMany({
        where: { warehouseId },
      }),
      this.prisma.syncOperation.aggregate({
        where: {
          organizationId: orgId,
          ...(horizon !== null
            ? { serverSeq: { lte: horizon } }
            : this.pullSafetyMs > 0
              ? { receivedAt: { lte: new Date(Date.now() - this.pullSafetyMs) } }
              : {}),
        },
        _max: { serverSeq: true },
      }),
    ]);

    return {
      warehouseId,
      products: products.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        barcode: p.barcode,
        unit: p.unit,
        price: Number(p.price),
        minStock: Number(p.minStock),
        quantity: Number(p.quantity),
      })),
      batches: batches.map((b) => ({
        id: b.id,
        productId: b.productId,
        warehouseId: b.warehouseId,
        quantity: Number(b.quantity),
        reserved: Number(b.reserved),
        costPrice: Number(b.costPrice),
        costCurrency: b.costCurrency ?? 'RUB',
        fxRate: Number(b.fxRate ?? 1),
        receivedAt: b.receivedAt.toISOString(),
        expiryDate: b.expiryDate ? b.expiryDate.toISOString() : null,
        status: b.status,
      })),
      cells: cells.map((c) => ({
        id: c.id,
        warehouseId: c.warehouseId,
        code: c.code,
        name: c.name,
      })),
      lastSeq: (agg._max.serverSeq ?? 0n).toString(),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // S7.3: классификация product_update по vector clocks.
  //  - apply: входящая правка — потомок последней (или первая правка поля);
  //  - stale: хранимая доминирует над входящей (правка устарела);
  //  - concurrent: ни одна не доминирует → смысловой конфликт, голосование.
  // ───────────────────────────────────────────────────────────────────────────
  private async classifyProductUpdate(
    caller: SyncCaller,
    op: ValidatedOperation,
  ): Promise<
    | { kind: 'apply' }
    | { kind: 'stale' }
    | { kind: 'concurrent'; conflictId: string; field: string; serverSeq: bigint }
  > {
    const payload = op.payload as ProductUpdatePayload;

    // Последняя ПРИНЯТАЯ правка ЭТОГО ЖЕ поля этого товара. Фильтруем по
    // payload.field прямым JSON path-фильтром Prisma (PostgreSQL) — иначе окно
    // из N последних операций по ДРУГИМ полям могло бы скрыть истинную последнюю
    // правку этого поля и ложно вернуть apply (конфликт не детектировался бы).
    const last = await this.prisma.syncOperation.findFirst({
      where: {
        entityType: 'product',
        entityId: op.entityId,
        operation: 'product_update',
        status: 'accepted',
        payload: { path: ['field'], equals: payload.field },
      },
      orderBy: { serverSeq: 'desc' },
    });
    if (!last) return { kind: 'apply' };

    const lastClock = (last.vectorClock ?? {}) as Record<string, number>;
    const incoming = op.vectorClock;

    if (dominates(incoming, lastClock)) return { kind: 'apply' };
    if (dominates(lastClock, incoming) && !isConcurrent(incoming, lastClock)) {
      return { kind: 'stale' };
    }

    // Конкуррентная правка: открываем голосование. optionA — текущее серверное
    // значение, optionB — входящее.
    const product = await this.prisma.product.findUnique({ where: { id: op.entityId } });
    const currentValue = product
      ? (product as unknown as Record<string, unknown>)[payload.field]
      : null;

    const vote = await this.conflicts.openSemanticConflict({
      orgId: caller.orgId,
      entityType: 'product',
      entityId: op.entityId,
      field: payload.field,
      optionA: {
        value: this.plainValue(currentValue),
        deviceId: last.deviceId,
        userId: last.userId,
        vectorClock: lastClock,
      },
      optionB: {
        value: payload.value,
        deviceId: caller.deviceId,
        userId: caller.userId,
        vectorClock: incoming,
      },
    });

    const rec = await this.recordOnly(caller, op, 'conflict');
    return {
      kind: 'concurrent',
      conflictId: vote.id,
      field: payload.field,
      serverSeq: rec.serverSeq,
    };
  }

  // Записать SyncOperation БЕЗ применения к мастер-БД (stale/conflict-случаи).
  private async recordOnly(
    caller: SyncCaller,
    op: ValidatedOperation,
    status: 'accepted' | 'conflict' | 'rejected',
  ): Promise<{ serverSeq: bigint }> {
    const warehouseId =
      op.operation === 'product_update' ? null : op.payload.warehouseId;
    const record = await this.prisma.syncOperation.create({
      data: {
        id: op.id,
        organizationId: caller.orgId,
        deviceId: caller.deviceId,
        userId: caller.userId,
        warehouseId,
        entityType: op.entityType,
        entityId: op.entityId,
        operation: op.operation,
        payload: op.payload as Prisma.InputJsonValue,
        vectorClock: op.vectorClock as Prisma.InputJsonValue,
        status,
        createdAt: new Date(op.createdAt),
      },
    });
    return { serverSeq: record.serverSeq };
  }

  // S7.2: уведомление о недостаче (после физического конфликта).
  private async notifyShortage(
    orgId: string,
    op: ValidatedOperation,
    shortage: number,
  ): Promise<void> {
    if (op.operation === 'product_update') return;
    const payload = op.payload as BatchWriteoffPayload | BatchReceiptPayload;
    const product = await this.prisma.product.findUnique({
      where: { id: payload.productId },
    });
    await this.conflicts.notifyPhysicalShortage({
      orgId,
      productId: payload.productId,
      productName: product?.name ?? payload.productId,
      warehouseId: payload.warehouseId ?? null,
      shortage,
    });
  }

  // Decimal/Date → примитив для хранения в Json optionA.
  private plainValue(v: unknown): unknown {
    if (v && typeof v === 'object' && 'toNumber' in (v as object)) {
      return (v as { toNumber(): number }).toNumber();
    }
    return v;
  }

  // Проверка, что склад и (для receipt/writeoff) товар принадлежат организации.
  // Несоответствие → OperationRejected (операция уходит в rejected[], 200 на push).
  private async assertOrgAccess(orgId: string, op: ValidatedOperation): Promise<void> {
    const warehouseId =
      op.operation === 'product_update' ? null : op.payload.warehouseId;

    if (warehouseId) {
      const wh = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
      if (!wh || wh.organizationId !== orgId) {
        throw new OperationRejected('warehouse not in organization');
      }
    }

    const productId =
      op.operation === 'product_update' ? op.entityId : op.payload.productId;
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product || product.organizationId !== orgId) {
      throw new OperationRejected('product not in organization');
    }
  }

  // Разложить уже известную (ранее принятую) операцию по accepted/conflicts/
  // rejected согласно её сохранённому статусу. Используется и при стартовой
  // проверке идемпотентности (findUnique), и при гонке (P2002 на create).
  // Возвращает serverSeq записи (для пересчёта maxServerSeq у вызывающего).
  private classifyKnown(
    known: { serverSeq: bigint; status: string; payload: unknown },
    id: string,
    accepted: AcceptedEntry[],
    conflicts: ConflictEntry[],
    rejected: RejectedEntry[],
  ): bigint {
    if (known.status === 'conflict') {
      conflicts.push({
        id,
        type: 'physical',
        detail: this.conflictDetailFromKnown(known.payload),
      });
    } else if (known.status === 'accepted') {
      accepted.push({ id, serverSeq: known.serverSeq.toString(), status: 'accepted' });
    } else {
      rejected.push({ id, error: 'previously rejected' });
    }
    return known.serverSeq;
  }

  // Восстановить detail конфликта из сохранённого payload (для идемпотентного
  // повтора конфликтной операции). Точный shortage не пересчитываем — отдаём
  // requested как нижнюю границу (полная картина — в S7).
  private conflictDetailFromKnown(payload: unknown): ConflictEntry['detail'] {
    const qty =
      payload && typeof payload === 'object' && 'quantity' in payload
        ? Number((payload as { quantity: unknown }).quantity)
        : 0;
    return { shortage: qty, requested: qty, available: 0 };
  }
}
