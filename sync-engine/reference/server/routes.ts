// Роуты приёма синхронизации (/api/v1/sync/*) — Фаза 2, S5.
// POST /sync/push — под app.authenticate (десктоп шлёт операции своей сессией).
// Зависимости (prisma) инжектируемы — для тестов с фейком.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { Permission } from '@smartstock/shared';
import { ZodError } from 'zod';
import type { DomainEvents } from '../../plugins/domain-events';
import { incSyncOperation } from '../../plugins/metrics.plugin';
import { SyncService, SyncNotFound, DeviceBlocked } from './service';
import { ConflictError, type ConflictNotifier } from './conflict.service';
import {
  pushBodySchema,
  pullQuerySchema,
  snapshotQuerySchema,
  conflictsQuerySchema,
  voteBodySchema,
  resolveConflictSchema,
} from './schema';

export interface SyncRoutesOptions {
  prisma: PrismaClient;
  events?: DomainEvents;
  notifier?: ConflictNotifier;
  // Окно безопасности pull (мс). См. SyncService.pullSafetyMs.
  pullSafetyMs?: number;
}

function handleError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ZodError) {
    return reply
      .status(400)
      .send({ error: 'ValidationError', message: 'Невалидное тело запроса', issues: err.issues });
  }
  if (err instanceof DeviceBlocked) {
    return reply.status(403).send({ error: 'DeviceBlocked', message: err.message });
  }
  if (err instanceof SyncNotFound) {
    return reply.status(404).send({ error: 'NotFound', message: err.message });
  }
  if (err instanceof ConflictError) {
    return reply.status(err.statusCode).send({ error: err.code, message: err.message });
  }
  throw err;
}

export async function registerSyncRoutes(
  app: FastifyInstance,
  opts: SyncRoutesOptions,
): Promise<void> {
  const service = new SyncService({
    prisma: opts.prisma,
    events: opts.events,
    notifier: opts.notifier,
    pullSafetyMs: opts.pullSafetyMs,
  });

  // POST /sync/push — приём пачки операций десктопа.
  // Доступ к складу/товару проверяется на уровне организации внутри сервиса
  // (несоответствие → операция в rejected[], 200 на весь push).
  app.post(
    '/api/v1/sync/push',
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply) => {
      try {
        const body = pushBodySchema.parse(request.body);
        const result = await service.push(
          {
            userId: request.user.sub,
            orgId: request.user.orgId,
            deviceId: body.deviceId,
          },
          body.operations,
        );
        // Бизнес-метрика: сводка результата push по статусам (no-op без /metrics).
        incSyncOperation('push', 'accepted', result.accepted.length);
        incSyncOperation('push', 'conflict', result.conflicts.length);
        incSyncOperation('push', 'rejected', result.rejected.length);
        return reply.send(result);
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  // GET /sync/pull — чужие операции с serverSeq > since (S6.1).
  app.get(
    '/api/v1/sync/pull',
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply) => {
      try {
        const q = pullQuerySchema.parse(request.query);
        const result = await service.pull(
          request.user.orgId,
          q.deviceId,
          BigInt(q.since),
          q.limit,
        );
        return reply.send(result);
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  // GET /sync/snapshot — полный снимок склада для первой синхронизации (S6.2).
  app.get(
    '/api/v1/sync/snapshot',
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply) => {
      try {
        const q = snapshotQuerySchema.parse(request.query);
        const result = await service.snapshot(request.user.orgId, q.warehouseId);
        return reply.send(result);
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  // ───────────────────────────────────────────────────────────────────────────
  // S7: конфликты и голосование
  // ───────────────────────────────────────────────────────────────────────────

  // Список конфликтов организации (админка + polling десктопа).
  app.get(
    '/api/v1/conflicts',
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply) => {
      try {
        const q = conflictsQuerySchema.parse(request.query);
        return reply.send({
          items: await service.conflicts.list(request.user.orgId, q.status),
        });
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  // Голос в смысловом конфликте (право на правку товаров; один голос на человека).
  app.post(
    '/api/v1/conflicts/:id/vote',
    {
      preHandler: [app.authenticate, app.requirePermission(Permission.PRODUCTS_EDIT)],
    },
    async (request: FastifyRequest, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = voteBodySchema.parse(request.body);
        const result = await service.conflicts.vote(
          { userId: request.user.sub, orgId: request.user.orgId },
          id,
          body.choice,
        );
        return reply.send(result);
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  // Решение конфликта админом: по большинству (равенство → 409) или вето.
  app.post(
    '/api/v1/sync/resolve-conflict',
    {
      preHandler: [app.authenticate, app.requirePermission(Permission.SETTINGS_MANAGE)],
    },
    async (request: FastifyRequest, reply) => {
      try {
        const body = resolveConflictSchema.parse(request.body);
        const result = await service.conflicts.resolve(
          { userId: request.user.sub, orgId: request.user.orgId },
          body,
        );
        return reply.send(result);
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );
}
