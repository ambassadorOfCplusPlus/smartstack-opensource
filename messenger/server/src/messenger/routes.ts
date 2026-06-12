// Роуты мессенджера (/api/v1/messenger). Адаптировано из SmartStock:
// убрана зависимость от RBAC/JWT-организации ERP. Админские роуты защищены
// одним токеном (ADMIN_TOKEN из окружения), а не правами пользователя.
//
// Админ (Bearer ADMIN_TOKEN):
//   GET    /messenger/users        — список аккаунтов
//   POST   /messenger/users        — создать аккаунт → {messengerId} (ключ)
//   DELETE /messenger/users/:id     — удалить аккаунт
//   GET    /messenger/capacity      — лимит/занято + оценка ресурсов
//   PUT    /messenger/limit         — изменить лимит {limit}
//   GET    /messenger/publish       — статус публичного туннеля
// Публично: register/login по ключу. Переписка — по токену мессенджера.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { ZodError } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import multipart from '@fastify/multipart';
import { resolveFileStorage } from '../lib/file-storage';

const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 МБ
import { MessengerService, MessengerError } from './service';
import { MessengerChatService, MessengerChatError } from './chat.service';
import { ChatError } from '../lib/attachments'; // бросается assertAllowedAttachment
import { tunnelStatus } from './tunnel';
import {
  setLimitSchema,
  idParamSchema,
  registerSchema,
  loginSchema,
  searchQuerySchema,
  createConvSchema,
  createGroupSchema,
  addMemberSchema,
  convIdParamSchema,
  sendMessageSchema,
  messagesQuerySchema,
  setKeySchema,
  sealedSendSchema,
} from './schema';

export interface MessengerRoutesOptions {
  prisma: PrismaClient;
  // Единственная организация-инстанс (standalone): админ-запросы не несут JWT,
  // поэтому orgId для них берём отсюда.
  instanceOrgId: string;
}

function handleError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof MessengerError || err instanceof MessengerChatError || err instanceof ChatError) {
    return reply.status(err.statusCode).send({ error: err.name, message: err.message });
  }
  if (err instanceof ZodError) {
    return reply
      .status(400)
      .send({ error: 'ValidationError', message: 'Невалидные данные', issues: err.issues });
  }
  throw err;
}

// Сравнение токенов в постоянном времени (анти-тайминг). Длины могут не совпадать
// — заранее проверяем и используем буферы одинаковой длины.
function safeTokenEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function registerMessengerRoutes(
  app: FastifyInstance,
  opts: MessengerRoutesOptions,
): Promise<void> {
  const service = new MessengerService(opts.prisma);
  const INSTANCE_ORG_ID = opts.instanceOrgId;

  // Простой админ-гард: заголовок `Authorization: Bearer <ADMIN_TOKEN>`.
  async function adminGuard(request: FastifyRequest, reply: FastifyReply) {
    const expected = process.env.ADMIN_TOKEN ?? '';
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!expected || !token || !safeTokenEqual(token, expected)) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Нужен админ-токен' });
    }
  }
  const guard = { preHandler: adminGuard };

  app.get('/api/v1/messenger/users', guard, async (_request: FastifyRequest, reply) => {
    try {
      return reply.send({ items: await service.list(INSTANCE_ORG_ID) });
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.post('/api/v1/messenger/users', guard, async (_request: FastifyRequest, reply) => {
    try {
      return reply.status(201).send(await service.create(INSTANCE_ORG_ID));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.delete('/api/v1/messenger/users/:id', guard, async (request: FastifyRequest, reply) => {
    try {
      const { id } = idParamSchema.parse(request.params);
      return reply.send(await service.remove(INSTANCE_ORG_ID, id));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get('/api/v1/messenger/capacity', guard, async (_request: FastifyRequest, reply) => {
    try {
      return reply.send(await service.capacity(INSTANCE_ORG_ID));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.put('/api/v1/messenger/limit', guard, async (request: FastifyRequest, reply) => {
    try {
      const body = setLimitSchema.parse(request.body);
      return reply.send(await service.setLimit(INSTANCE_ORG_ID, body.limit));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  // ── Публикация мессенджера наружу (Cloudflare-туннель, отдельный контейнер) ──
  // Статус + публичный адрес. Сам туннель поднимается профилем `tunnel` в
  // docker-compose, API лишь читает адрес.
  app.get('/api/v1/messenger/publish', guard, async (_request: FastifyRequest, reply) => {
    const s = await tunnelStatus();
    return reply.send({ ...s, clientUrl: s.url ? `${s.url}/m/` : null });
  });

  // ── Публичные эндпоинты для клиента мессенджера (без auth) ──────────────────

  // Регистрация по ключу: имя + пароль (+ почта). Активирует аккаунт.
  app.post('/api/v1/messenger/register', async (request: FastifyRequest, reply) => {
    try {
      const b = registerSchema.parse(request.body);
      return reply
        .status(201)
        .send(await service.register(b.messengerId, b.displayName, b.password, b.recoveryEmail));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  // Вход по ключу+паролю → access-токен мессенджера (kind='messenger').
  app.post('/api/v1/messenger/login', async (request: FastifyRequest, reply) => {
    try {
      const b = loginSchema.parse(request.body);
      const u = await service.login(b.messengerId, b.password);
      const accessToken = app.jwt.sign({
        sub: u.id,
        orgId: u.organizationId,
        email: '',
        kind: 'messenger',
      });
      return reply.send({
        accessToken,
        user: { id: u.id, messengerId: u.messengerId, displayName: u.displayName },
      });
    } catch (err) {
      return handleError(reply, err);
    }
  });

  // ── Переписка (по токену мессенджера) ───────────────────────────────────────
  const storage = resolveFileStorage({
    minioEndpoint: process.env.MINIO_ENDPOINT,
    minioPort: process.env.MINIO_PORT ? Number(process.env.MINIO_PORT) : undefined,
    minioUseSSL: process.env.MINIO_USE_SSL === 'true',
    minioAccessKey: process.env.MINIO_ACCESS_KEY,
    minioSecretKey: process.env.MINIO_SECRET_KEY,
  });
  const chat = new MessengerChatService(opts.prisma, storage);

  // Multipart для вложений (идемпотентно).
  if (!app.hasContentTypeParser('multipart/form-data')) {
    await app.register(multipart, { limits: { fileSize: ATTACHMENT_MAX_BYTES } });
  }

  // preHandler: токен с kind='messenger' + аккаунт ещё активен (не заблокирован).
  async function messengerAuth(request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Неверный или просроченный токен' });
    }
    const u = request.user;
    if (u.kind !== 'messenger') {
      return reply.status(403).send({ error: 'Forbidden', message: 'Нужен токен мессенджера' });
    }
    const mu = await opts.prisma.messengerUser.findUnique({ where: { id: u.sub } });
    if (!mu || !mu.isActive) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Аккаунт отключён администратором' });
    }
  }
  const caller = (request: FastifyRequest) => ({ userId: request.user.sub, orgId: request.user.orgId });
  const mGuard = { preHandler: messengerAuth };

  // E2E: опубликовать свой публичный ключ (клиент генерирует пару при первом входе).
  app.put('/api/v1/messenger/chat/keys', mGuard, async (request: FastifyRequest, reply) => {
    try {
      const b = setKeySchema.parse(request.body);
      return reply.send(await chat.setPublicKey(caller(request), b.publicKey));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get('/api/v1/messenger/chat/contacts', mGuard, async (request: FastifyRequest, reply) => {
    try {
      const q = searchQuerySchema.parse(request.query);
      return reply.send({ items: await chat.searchContacts(caller(request), q.q ?? '') });
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get('/api/v1/messenger/chat/conversations', mGuard, async (request: FastifyRequest, reply) => {
    try {
      return reply.send({ items: await chat.listConversations(caller(request)) });
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.post('/api/v1/messenger/chat/conversations', mGuard, async (request: FastifyRequest, reply) => {
    try {
      const b = createConvSchema.parse(request.body);
      const r = await chat.createConversation(caller(request), b.participantId);
      return reply.status(r.existed ? 200 : 201).send(r);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.post('/api/v1/messenger/chat/groups', mGuard, async (request: FastifyRequest, reply) => {
    try {
      const b = createGroupSchema.parse(request.body);
      return reply.status(201).send(await chat.createGroup(caller(request), b.title, b.participantIds));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.post('/api/v1/messenger/chat/conversations/:id/members', mGuard, async (request: FastifyRequest, reply) => {
    try {
      const { id } = convIdParamSchema.parse(request.params);
      const b = addMemberSchema.parse(request.body);
      return reply.send(await chat.addMember(caller(request), id, b.userId));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get('/api/v1/messenger/chat/conversations/:id/messages', mGuard, async (request: FastifyRequest, reply) => {
    try {
      const { id } = convIdParamSchema.parse(request.params);
      const q = messagesQuerySchema.parse(request.query);
      return reply.send({ items: await chat.listMessages(caller(request), id, q.page, q.limit) });
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.post('/api/v1/messenger/chat/conversations/:id/messages', mGuard, async (request: FastifyRequest, reply) => {
    try {
      const { id } = convIdParamSchema.parse(request.params);
      const b = sendMessageSchema.parse(request.body);
      return reply.status(201).send(await chat.sendMessage(caller(request), id, b.body ?? '', b.attachmentUrl));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.post('/api/v1/messenger/chat/conversations/:id/read', mGuard, async (request: FastifyRequest, reply) => {
    try {
      const { id } = convIdParamSchema.parse(request.params);
      return reply.send(await chat.markRead(caller(request), id));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  // ── Sealed-sender: приватная отправка (сервер не знает автора) ───────────────
  // Участник по своему токену получает общий секрет постинга диалога (postToken).
  app.get('/api/v1/messenger/chat/conversations/:id/post-token', mGuard, async (request: FastifyRequest, reply) => {
    try {
      const { id } = convIdParamSchema.parse(request.params);
      return reply.send(await chat.getPostToken(caller(request), id));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  // Отправка БЕЗ токена личности — авторизация секретом диалога в теле (postToken).
  // Сервер не сохраняет senderId → не знает, кто из участников написал.
  app.post('/api/v1/messenger/chat/conversations/:id/sealed-messages', async (request: FastifyRequest, reply) => {
    try {
      const { id } = convIdParamSchema.parse(request.params);
      const b = sealedSendSchema.parse(request.body);
      return reply
        .status(201)
        .send(await chat.sealedSend(id, b.postToken, b.body ?? '', b.attachmentUrl, b.type ?? 'msg'));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  // Sealed-вложение: загрузка (multipart) по секрету диалога в заголовке
  // x-post-token. Содержимое уже E2E. Возвращает {key} для sealed-сообщения.
  app.post('/api/v1/messenger/chat/conversations/:id/sealed-attachments', async (request: FastifyRequest, reply) => {
    try {
      const { id } = convIdParamSchema.parse(request.params);
      const postToken = (request.headers['x-post-token'] as string | undefined) ?? '';
      if (!postToken) return reply.status(400).send({ error: 'BadRequest', message: 'Нет x-post-token' });
      const file = await request.file();
      if (!file) return reply.status(400).send({ error: 'ValidationError', message: 'Файл не передан' });
      const buffer = await file.toBuffer();
      if (file.file.truncated) {
        return reply.status(413).send({ error: 'PayloadTooLarge', message: 'Файл превышает 25 МБ' });
      }
      return reply
        .status(201)
        .send(await chat.sealedUploadAttachment(id, postToken, buffer, file.mimetype, file.filename));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  // Sealed-вложение: скачивание. Ключ и секрет — в ЗАГОЛОВКАХ (x-att-key,
  // x-post-token), не в URL → не оседают в логах/истории.
  app.get('/api/v1/messenger/chat/sealed-attachments/download', async (request: FastifyRequest, reply) => {
    try {
      const postToken = (request.headers['x-post-token'] as string | undefined) ?? '';
      const key = (request.headers['x-att-key'] as string | undefined) ?? '';
      if (!postToken || !key) {
        return reply.status(400).send({ error: 'BadRequest', message: 'Нужны x-att-key и x-post-token' });
      }
      const { buffer, filename } = await chat.sealedDownloadAttachment(postToken, key);
      return reply.header('Content-Disposition', `attachment; filename="${filename}"`).send(buffer);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  // Загрузить вложение (multipart) → {key, filename}. Затем шлём сообщение с
  // attachmentUrl = key.
  app.post('/api/v1/messenger/chat/conversations/:id/attachments', mGuard, async (request: FastifyRequest, reply) => {
    try {
      const { id } = convIdParamSchema.parse(request.params);
      const file = await request.file();
      if (!file) return reply.status(400).send({ error: 'ValidationError', message: 'Файл не передан' });
      const buffer = await file.toBuffer();
      if (file.file.truncated) {
        return reply.status(413).send({ error: 'PayloadTooLarge', message: 'Файл превышает 25 МБ' });
      }
      const r = await chat.uploadAttachment(caller(request), id, buffer, file.mimetype, file.filename);
      return reply.status(201).send(r);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  // Скачать вложение (ключ как ?key64=base64url, чтобы слэши не ломали путь).
  app.get('/api/v1/messenger/chat/attachments/download', mGuard, async (request: FastifyRequest, reply) => {
    try {
      const q = request.query as { key?: string; key64?: string };
      let key: string | undefined = q.key;
      if (!key && q.key64) {
        try {
          key = Buffer.from(q.key64, 'base64url').toString('utf8');
        } catch {
          return reply.status(400).send({ error: 'BadKey', message: 'Недопустимый ключ' });
        }
      }
      if (!key) return reply.status(400).send({ error: 'BadKey', message: 'Не передан ключ вложения' });
      const { buffer, filename } = await chat.downloadAttachment(caller(request), key);
      return reply.header('Content-Disposition', `attachment; filename="${filename}"`).send(buffer);
    } catch (err) {
      return handleError(reply, err);
    }
  });
}
