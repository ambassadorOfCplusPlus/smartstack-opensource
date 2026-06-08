// MessengerChatService — изолированная переписка мессенджера (вариант 2).
// Работает поверх отдельных таблиц messenger_conversations/participants/messages,
// никак не пересекается с chat_*/users. Звонящий — мессенджер-юзер (по токену
// kind='messenger'). Реал-тайм клиента — опрос (как в основном чате), сокетов нет
// → серверу дёшево.

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { isUnsafeStorageKey, safeStorageName, type FileStorage } from '../lib/file-storage';
import { assertAllowedAttachment } from '../lib/attachments';

export const MESSENGER_BUCKET = 'messenger';

export class MessengerChatError extends Error {
  constructor(
    public statusCode: number,
    name: string,
    message: string,
  ) {
    super(message);
    this.name = name;
  }
}

export interface MessengerCaller {
  userId: string; // messengerUserId (из токена sub)
  orgId: string;
}

export class MessengerChatService {
  constructor(
    private prisma: PrismaClient,
    private storage?: FileStorage,
  ) {}

  private displayName(u: { displayName: string | null; messengerId: string }): string {
    return u.displayName?.trim() || u.messengerId;
  }

  // E2E: задать свой публичный ключ (клиент генерирует пару при первом запуске).
  async setPublicKey(caller: MessengerCaller, publicKey: string) {
    await this.prisma.messengerUser.update({
      where: { id: caller.userId },
      data: { publicKey },
    });
    return { ok: true };
  }

  // Поиск собеседников: зарегистрированные мессенджер-юзеры организации, кроме
  // себя, по части имени или ключа. Пустой запрос → все (до 50).
  async searchContacts(caller: MessengerCaller, q: string) {
    const term = q.trim();
    const users = await this.prisma.messengerUser.findMany({
      where: {
        organizationId: caller.orgId,
        isActive: true,
        registeredAt: { not: null },
        id: { not: caller.userId },
        ...(term
          ? {
              OR: [
                { displayName: { contains: term, mode: 'insensitive' } },
                { messengerId: { contains: term.toUpperCase() } },
              ],
            }
          : {}),
      },
      select: { id: true, messengerId: true, displayName: true, publicKey: true },
      orderBy: [{ displayName: 'asc' }],
      take: 50,
    });
    return users.map((u) => ({
      id: u.id,
      messengerId: u.messengerId,
      name: this.displayName(u),
      publicKey: u.publicKey, // для E2E-шифрования сообщений этому контакту
    }));
  }

  private async assertParticipant(caller: MessengerCaller, conversationId: string) {
    const p = await this.prisma.messengerParticipant.findUnique({
      where: { conversationId_messengerUserId: { conversationId, messengerUserId: caller.userId } },
    });
    if (!p) throw new MessengerChatError(404, 'NotFound', 'Диалог не найден');
    return p;
  }

  // Диалоги пользователя + последнее сообщение + число непрочитанных.
  async listConversations(caller: MessengerCaller) {
    const memberships = await this.prisma.messengerParticipant.findMany({
      where: { messengerUserId: caller.userId },
    });
    const convIds = memberships.map((m) => m.conversationId);
    if (convIds.length === 0) return [];

    const conversations = await this.prisma.messengerConversation.findMany({
      where: { id: { in: convIds }, organizationId: caller.orgId },
      include: {
        participants: { include: { messengerUser: { select: { id: true, messengerId: true, displayName: true, publicKey: true } } } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const byId = new Map(memberships.map((m) => [m.conversationId, m]));
    const out = [];
    for (const conv of conversations) {
      const mine = byId.get(conv.id);
      const lastReadAt = mine?.lastReadAt ?? null;
      const unread = await this.prisma.messengerMessage.count({
        where: {
          conversationId: conv.id,
          senderId: { not: caller.userId },
          ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
        },
      });
      const others = conv.participants
        .filter((p) => p.messengerUserId !== caller.userId)
        .map((p) => ({
          id: p.messengerUser.id,
          name: this.displayName(p.messengerUser),
          publicKey: p.messengerUser.publicKey, // для E2E
        }));
      const last = conv.messages[0];
      out.push({
        id: conv.id,
        isGroup: conv.isGroup,
        title: conv.title ?? (others.map((o) => o.name).join(', ') || 'Диалог'),
        participants: others,
        unread,
        lastMessage: last ? { body: last.body, createdAt: last.createdAt, senderId: last.senderId } : null,
      });
    }
    return out;
  }

  // Создать (или вернуть существующий) 1-на-1 диалог с другим мессенджер-юзером.
  async createConversation(caller: MessengerCaller, otherId: string) {
    if (otherId === caller.userId) {
      throw new MessengerChatError(400, 'BadRequest', 'Нельзя начать диалог с собой');
    }
    const other = await this.prisma.messengerUser.findUnique({ where: { id: otherId } });
    if (!other || other.organizationId !== caller.orgId || !other.isActive) {
      throw new MessengerChatError(404, 'NotFound', 'Собеседник не найден');
    }

    // Дедуп 1-на-1: ищем диалог ровно с этими двумя участниками.
    const mine = await this.prisma.messengerParticipant.findMany({
      where: { messengerUserId: caller.userId },
      select: { conversationId: true },
    });
    for (const m of mine) {
      const parts = await this.prisma.messengerParticipant.findMany({
        where: { conversationId: m.conversationId },
      });
      if (parts.length === 2 && parts.some((p) => p.messengerUserId === otherId)) {
        return { id: m.conversationId, existed: true };
      }
    }

    const conv = await this.prisma.messengerConversation.create({
      data: {
        organizationId: caller.orgId,
        isGroup: false,
        participants: {
          create: [{ messengerUserId: caller.userId }, { messengerUserId: otherId }],
        },
      },
    });
    return { id: conv.id, existed: false };
  }

  // Создать групповой диалог с названием и набором участников (E2E — пер-получательский
  // конверт на клиенте: сообщение шифруется публичным ключом каждого участника).
  async createGroup(caller: MessengerCaller, title: string, participantIds: string[]) {
    const ids = Array.from(new Set(participantIds.filter((id) => id && id !== caller.userId)));
    if (ids.length === 0) {
      throw new MessengerChatError(400, 'BadRequest', 'Добавьте хотя бы одного участника');
    }
    const users = await this.prisma.messengerUser.findMany({
      where: { id: { in: ids }, organizationId: caller.orgId, isActive: true },
    });
    if (users.length !== ids.length) {
      throw new MessengerChatError(404, 'NotFound', 'Некоторые участники не найдены');
    }
    const conv = await this.prisma.messengerConversation.create({
      data: {
        organizationId: caller.orgId,
        isGroup: true,
        title: title.trim() || 'Группа',
        participants: {
          create: [caller.userId, ...ids].map((id) => ({ messengerUserId: id })),
        },
      },
    });
    return { id: conv.id };
  }

  // Добавить участника в группу (может любой участник группы).
  async addMember(caller: MessengerCaller, conversationId: string, userId: string) {
    await this.assertParticipant(caller, conversationId);
    const conv = await this.prisma.messengerConversation.findFirst({
      where: { id: conversationId, organizationId: caller.orgId },
    });
    if (!conv) throw new MessengerChatError(404, 'NotFound', 'Диалог не найден');
    if (!conv.isGroup) {
      throw new MessengerChatError(400, 'BadRequest', 'Добавлять участников можно только в группу');
    }
    const user = await this.prisma.messengerUser.findUnique({ where: { id: userId } });
    if (!user || user.organizationId !== caller.orgId || !user.isActive) {
      throw new MessengerChatError(404, 'NotFound', 'Пользователь не найден');
    }
    await this.prisma.messengerParticipant.upsert({
      where: { conversationId_messengerUserId: { conversationId, messengerUserId: userId } },
      create: { conversationId, messengerUserId: userId },
      update: {},
    });
    return { ok: true };
  }

  async listMessages(caller: MessengerCaller, conversationId: string, page = 1, limit = 50) {
    await this.assertParticipant(caller, conversationId);
    const take = Math.min(Math.max(limit, 1), 100);
    const messages = await this.prisma.messengerMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      skip: (Math.max(page, 1) - 1) * take,
      take,
    });
    return messages.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      body: m.body,
      attachmentUrl: m.attachmentUrl,
      createdAt: m.createdAt,
    }));
  }

  async sendMessage(
    caller: MessengerCaller,
    conversationId: string,
    body: string,
    attachmentUrl?: string,
  ) {
    await this.assertParticipant(caller, conversationId);
    const text = body.trim();
    if (!text && !attachmentUrl) {
      throw new MessengerChatError(400, 'BadRequest', 'Пустое сообщение');
    }
    const msg = await this.prisma.messengerMessage.create({
      data: { conversationId, senderId: caller.userId, body: text, attachmentUrl: attachmentUrl ?? null },
    });
    // Поднять диалог в списке (updatedAt) для сортировки.
    await this.prisma.messengerConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    return {
      id: msg.id,
      senderId: msg.senderId,
      body: msg.body,
      attachmentUrl: msg.attachmentUrl,
      createdAt: msg.createdAt,
    };
  }

  async markRead(caller: MessengerCaller, conversationId: string) {
    await this.assertParticipant(caller, conversationId);
    await this.prisma.messengerParticipant.update({
      where: { conversationId_messengerUserId: { conversationId, messengerUserId: caller.userId } },
      data: { lastReadAt: new Date() },
    });
    return { ok: true };
  }

  // Загрузить вложение в диалог. Ключ: messenger/{conversationId}/{uuid}_{file}.
  // Затем клиент шлёт сообщение с attachmentUrl = key.
  async uploadAttachment(
    caller: MessengerCaller,
    conversationId: string,
    buffer: Buffer,
    mime: string,
    filename: string,
  ) {
    await this.assertParticipant(caller, conversationId);
    if (!this.storage) {
      throw new MessengerChatError(500, 'StorageUnavailable', 'Файловое хранилище не настроено');
    }
    assertAllowedAttachment(mime, filename); // белый список типов (отсекает .exe/.html)
    const base = filename.split(/[\\/]/).pop() ?? 'file';
    const safeName = safeStorageName(base, 200) || 'file';
    const key = `${MESSENGER_BUCKET}/${conversationId}/${randomUUID()}_${safeName}`;
    const url = await this.storage.upload(MESSENGER_BUCKET, key, buffer, mime);
    return { url, key, filename: safeName, size: buffer.length, mimeType: mime };
  }

  // Скачать вложение — только участнику диалога, к которому относится ключ.
  async downloadAttachment(caller: MessengerCaller, key: string) {
    if (!this.storage) {
      throw new MessengerChatError(500, 'StorageUnavailable', 'Файловое хранилище не настроено');
    }
    if (isUnsafeStorageKey(key)) {
      throw new MessengerChatError(400, 'BadKey', 'Недопустимый ключ вложения');
    }
    const parts = key.split('/');
    if (parts.length < 3 || parts[0] !== MESSENGER_BUCKET) {
      throw new MessengerChatError(400, 'BadKey', 'Недопустимый ключ вложения');
    }
    // parts[1] — conversationId; проверяем участие звонящего.
    await this.assertParticipant(caller, parts[1]);
    const buffer = await this.storage.download(MESSENGER_BUCKET, key);
    if (!buffer) throw new MessengerChatError(404, 'NotFound', 'Файл не найден');
    const filename = parts.slice(2).join('/').replace(/^[0-9a-f-]+_/i, '');
    return { buffer, filename };
  }
}
