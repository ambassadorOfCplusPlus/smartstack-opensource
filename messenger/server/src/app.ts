// Минимальный standalone-Fastify для Smartstack Messenger.
// Никакого ERP: только JWT (для токенов мессенджера), multipart (вложения),
// одна организация-инстанс и роуты мессенджера.

import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import { registerMessengerRoutes } from './messenger/routes';

const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 МБ

export interface BuildAppResult {
  app: FastifyInstance;
  prisma: PrismaClient;
  instanceOrgId: string;
}

// Гарантирует ровно одну организацию-инстанс. Возвращает её id.
async function ensureInstanceOrg(prisma: PrismaClient): Promise<string> {
  const existing = await prisma.organization.findFirst({ orderBy: { name: 'asc' } });
  if (existing) return existing.id;
  const created = await prisma.organization.create({
    data: { name: 'Messenger', messengerUserLimit: 15 },
    select: { id: true },
  });
  return created.id;
}

export async function buildApp(prisma = new PrismaClient()): Promise<BuildAppResult> {
  // Приватность: НЕ логируем IP клиента и заголовки (в дефолтном req-сериализаторе
  // Fastify оседал remoteAddress). Оставляем только метод и путь.
  const app = Fastify({
    logger: {
      serializers: {
        req(req: { method: string; url: string }) {
          return { method: req.method, url: req.url };
        },
      },
    },
  });

  // JWT — для токенов мессенджера (kind='messenger'). access TTL из env.
  await app.register(jwt, {
    secret: process.env.JWT_SECRET ?? 'change-me-dev-secret',
    sign: { expiresIn: process.env.JWT_ACCESS_TTL ?? '30d' },
  });

  // Multipart — вложения (роуты тоже регистрируют идемпотентно, но делаем здесь
  // централизованно, с тем же лимитом).
  if (!app.hasContentTypeParser('multipart/form-data')) {
    await app.register(multipart, { limits: { fileSize: ATTACHMENT_MAX_BYTES } });
  }

  // Health.
  app.get('/api/v1/health/live', async (_req, reply) => reply.status(200).send({ status: 'ok' }));

  const instanceOrgId = await ensureInstanceOrg(prisma);
  await registerMessengerRoutes(app, { prisma, instanceOrgId });

  return { app, prisma, instanceOrgId };
}
