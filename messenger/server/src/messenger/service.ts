// MessengerService — реестр пользователей мессенджера (отдельный продукт).
// Админ создаёт аккаунт → выдаётся короткий messengerId (ключ); человек по нему
// потом регистрируется (Фаза 1b). Лимит — Organization.messengerUserLimit;
// SmartStock-пользователи в лимит НЕ входят (это другая таблица).
//
// Лёгкость по ресурсам: переписка переиспользует общий chat-слой и опрос (без
// сокетов), поэтому маржинальная стоимость на пользователя мала — см. capacity().

import type { PrismaClient } from '@prisma/client';
import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';

export class MessengerError extends Error {
  constructor(
    public statusCode: number,
    name: string,
    message: string,
  ) {
    super(message);
    this.name = name;
  }
}

// Оценка ресурсов мессенджера. Сервис разделяет инфраструктуру с API, поэтому на
// пользователя приходится немного: кэш контактов + периодический опрос диалогов.
const BASE_MB = 60; // базовый оверхед обслуживания мессенджера
const PER_USER_MB = 3; // ~ ОЗУ на активного пользователя (опрос/кэш)

// Алфавит без неоднозначных символов (нет 0/O/1/I/L) — код легко продиктовать.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;

export class MessengerService {
  constructor(private prisma: PrismaClient) {}

  private genCode(): string {
    let s = '';
    for (let i = 0; i < CODE_LEN; i++) {
      s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    return s;
  }

  // Список аккаунтов мессенджера организации.
  async list(orgId: string) {
    const items = await this.prisma.messengerUser.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        messengerId: true,
        displayName: true,
        isActive: true,
        registeredAt: true,
        createdAt: true,
      },
    });
    return items.map((u) => ({
      id: u.id,
      messengerId: u.messengerId,
      displayName: u.displayName,
      isActive: u.isActive,
      registered: u.registeredAt !== null, // зарегистрировался ли человек по ключу
      createdAt: u.createdAt,
    }));
  }

  // Создать аккаунт (выдать ключ). Проверяет лимит; messengerId уникален.
  async create(orgId: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new MessengerError(404, 'NotFound', 'Организация не найдена');

    const used = await this.prisma.messengerUser.count({ where: { organizationId: orgId } });
    if (used >= org.messengerUserLimit) {
      throw new MessengerError(
        409,
        'LimitReached',
        `Достигнут лимит пользователей мессенджера (${org.messengerUserLimit}). ` +
          'Увеличьте лимит или удалите неиспользуемые аккаунты.',
      );
    }

    // Генерируем уникальный код (ретрай на коллизию — она крайне маловероятна).
    for (let attempt = 0; attempt < 5; attempt++) {
      const messengerId = this.genCode();
      const exists = await this.prisma.messengerUser.findUnique({ where: { messengerId } });
      if (exists) continue;
      const created = await this.prisma.messengerUser.create({
        data: { organizationId: orgId, messengerId },
        select: { id: true, messengerId: true },
      });
      return { id: created.id, messengerId: created.messengerId };
    }
    throw new MessengerError(500, 'CodeCollision', 'Не удалось сгенерировать ключ, повторите');
  }

  // Удалить аккаунт мессенджера (только своей организации).
  async remove(orgId: string, id: string) {
    const u = await this.prisma.messengerUser.findUnique({ where: { id } });
    if (!u || u.organizationId !== orgId) {
      throw new MessengerError(404, 'NotFound', 'Аккаунт не найден');
    }
    await this.prisma.messengerUser.delete({ where: { id } });
    return { ok: true };
  }

  // Изменить лимит пользователей мессенджера. Нельзя ниже уже занятого.
  async setLimit(orgId: string, limit: number) {
    const used = await this.prisma.messengerUser.count({ where: { organizationId: orgId } });
    if (limit < used) {
      throw new MessengerError(
        409,
        'LimitBelowUsed',
        `Лимит (${limit}) меньше уже созданных аккаунтов (${used}).`,
      );
    }
    await this.prisma.organization.update({
      where: { id: orgId },
      data: { messengerUserLimit: limit },
    });
    return this.capacity(orgId);
  }

  // Регистрация по ключу (публично): человек задаёт имя + пароль (+ почту для
  // восстановления). Активирует ранее созданный админом аккаунт. Повторно нельзя.
  async register(
    messengerId: string,
    displayName: string,
    password: string,
    recoveryEmail?: string,
  ) {
    const u = await this.prisma.messengerUser.findUnique({ where: { messengerId } });
    if (!u) throw new MessengerError(404, 'NotFound', 'Ключ не найден');
    if (!u.isActive) throw new MessengerError(403, 'Inactive', 'Аккаунт отключён администратором');
    if (u.registeredAt) {
      throw new MessengerError(409, 'AlreadyRegistered', 'Этот ключ уже активирован');
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await this.prisma.messengerUser.update({
      where: { id: u.id },
      data: {
        displayName,
        passwordHash,
        recoveryEmail: recoveryEmail ?? null,
        registeredAt: new Date(),
      },
    });
    return { id: u.id, messengerId: u.messengerId, displayName };
  }

  // Проверка логина по ключу+паролю. Возвращает данные для подписи токена
  // (сам токен подписывает роут через app.jwt). Сообщения нейтральны (анти-перебор).
  async login(messengerId: string, password: string) {
    const u = await this.prisma.messengerUser.findUnique({ where: { messengerId } });
    if (!u || !u.passwordHash || !u.registeredAt) {
      throw new MessengerError(401, 'BadCredentials', 'Неверный ключ или пароль');
    }
    if (!u.isActive) throw new MessengerError(403, 'Inactive', 'Аккаунт отключён администратором');
    const ok = await bcrypt.compare(password, u.passwordHash);
    if (!ok) throw new MessengerError(401, 'BadCredentials', 'Неверный ключ или пароль');
    return {
      id: u.id,
      organizationId: u.organizationId,
      messengerId: u.messengerId,
      displayName: u.displayName,
    };
  }

  // Сводка по вместимости + оценка ресурсов (для админа: «нужно / ест сейчас»).
  async capacity(orgId: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new MessengerError(404, 'NotFound', 'Организация не найдена');
    const used = await this.prisma.messengerUser.count({ where: { organizationId: orgId } });
    const limit = org.messengerUserLimit;
    return {
      limit,
      used,
      free: Math.max(0, limit - used),
      // Оценка ОЗУ (МБ). Это приблизительный расчёт, не замер процесса.
      estimate: {
        perUserMb: PER_USER_MB,
        baseMb: BASE_MB,
        forLimitMb: BASE_MB + limit * PER_USER_MB, // потребуется на полный лимит
        currentMb: BASE_MB + used * PER_USER_MB, // ориентир текущего потребления
      },
    };
  }
}
