// Серверный журнал операций синхронизации (Фаза 2).
//
// ПРОБЛЕМА: серверные мутации остатков (перемещение между складами через REST,
// REST-приёмка партии) меняют мастер-БД напрямую, минуя журнал sync_operations.
// Десктопы тянут чужие операции через GET /sync/pull (serverSeq > since,
// deviceId != собственного). Если серверная мутация не попала в журнал — рой
// десктопов её НЕ УВИДИТ и разойдётся с сервером по остаткам.
//
// РЕШЕНИЕ: у каждой организации есть одно «серверное устройство» (Device с
// deviceName=SERVER_DEVICE_NAME). Все серверные мутации пишутся в sync_operations
// от его имени. Поскольку его deviceId не совпадает ни с одним десктопом, фильтр
// pull (deviceId != callerDeviceId) отдаст эти операции ВСЕМ десктопам.
//
// Контракт payload операций совпадает с десктопным applyRemote
// (см. desktop-sources/src/sync/OperationLog.cpp):
//  - batch_receipt: {productId, warehouseId, quantity, costPrice, receivedAt(ISO),
//    expiryDate?, costCurrency?, fxRate?}, entityId = batchId;
//  - batch_writeoff: {batchId, productId, warehouseId, quantity, reason},
//    entityId = batchId.
// vectorClock для batch-операций не используется (пишем {}).

import { randomUUID, createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

// Имя серверного устройства (одно на организацию).
export const SERVER_DEVICE_NAME = 'SmartStock Server (системное)';

// Минимальный транзакционный клиент, которого достаточно этому модулю. Берём
// подмножество Prisma.TransactionClient, чтобы фейк-Prisma в тестах не обязан
// был реализовывать весь интерфейс.
type JournalTx = Pick<Prisma.TransactionClient, 'device' | 'syncOperation'>;

// Детерминированный UUID серверного устройства по orgId (формат v5-подобный).
// Один и тот же для организации всегда → не нужен поиск/создание внутри
// критической транзакции, и невозможны дубли «серверного устройства» (находка
// адверсариал-ревью: findFirst+create под гонкой создавал ДВЕ записи).
export function serverDeviceId(orgId: string): string {
  const b = createHash('sha256')
    .update('smartstock:server-device:' + orgId)
    .digest()
    .subarray(0, 16);
  const u = Buffer.from(b);
  u[6] = (u[6] & 0x0f) | 0x50; // версия 5
  u[8] = (u[8] & 0x3f) | 0x80; // вариант RFC 4122
  const h = u.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Кэш орг, чьё серверное устройство уже подтверждено в этом процессе —
// устройство неизменно после создания, поэтому повторный findUnique на каждой
// серверной операции (transfer/приёмка) лишний (находка ревью). Сбрасывается
// при перезапуске процесса; на этот orgId после первого подтверждения round-trip
// к devices не делается.
const ensuredOrgs = new Set<string>();

// Сброс кэша — для тестов (каждый кейс поднимает свежую фейк-БД; без сброса
// кэш с прошлого кейса заставил бы пропустить создание устройства в новой БД).
export function __resetServerDeviceCache(): void {
  ensuredOrgs.clear();
}

// Гарантировать существование серверного устройства организации. Вызывать в
// СОБСТВЕННОЙ транзакции (top-level prisma) ДО критической Serializable-tx —
// иначе P2002 от гонки на create отравил бы критическую транзакцию (в Postgres
// после ошибки statement транзакция aborted). Идемпотентно: детерминированный
// id как PK, повторный create под гонкой даёт P2002 → трактуем как «уже есть».
export async function ensureServerDevice(
  prisma: Pick<PrismaClient, 'device'>,
  orgId: string,
  userId: string,
): Promise<string> {
  const id = serverDeviceId(orgId);
  if (ensuredOrgs.has(orgId)) return id;
  const existing = await prisma.device.findUnique({ where: { id } });
  if (existing) { ensuredOrgs.add(orgId); return id; }
  try {
    await prisma.device.create({
      data: { id, organizationId: orgId, userId, deviceName: SERVER_DEVICE_NAME, appVersion: 'server' },
    });
  } catch (e) {
    // Создано параллельным запросом — это ок (id детерминирован).
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
  }
  ensuredOrgs.add(orgId);
  return id;
}

// Одна серверная операция для записи в журнал.
export interface ServerOp {
  entityType: string;
  entityId: string;
  operation: 'batch_receipt' | 'batch_writeoff' | 'product_update';
  payload: object;
  warehouseId?: string | null;
}

export interface RecordServerOperationsArgs {
  orgId: string;
  userId: string;
  ops: ServerOp[];
}

// Записать серверные операции в журнал в рамках ПЕРЕДАННОЙ транзакции tx.
// Все операции получают deviceId серверного устройства (детерминированный по
// orgId), status='accepted', vectorClock={}. Возвращает максимальный serverSeq
// (0n — если ops пуст). Вызывать ВНУТРИ той же транзакции, что и сама мутация
// остатков (атомарность журнала и состояния). ВАЖНО: серверное устройство
// должно быть создано заранее через ensureServerDevice(prisma, ...) ДО этой
// транзакции — иначе FK deviceId не разрешится.
export async function recordServerOperations(
  tx: JournalTx,
  { orgId, userId, ops }: RecordServerOperationsArgs,
): Promise<bigint> {
  if (ops.length === 0) return 0n;

  const deviceId = serverDeviceId(orgId);

  let maxSeq = 0n;
  const now = new Date();
  for (const op of ops) {
    const record = await tx.syncOperation.create({
      data: {
        id: randomUUID(),
        organizationId: orgId,
        deviceId,
        userId,
        warehouseId: op.warehouseId ?? null,
        entityType: op.entityType,
        entityId: op.entityId,
        operation: op.operation,
        payload: op.payload as Prisma.InputJsonValue,
        vectorClock: {} as Prisma.InputJsonValue,
        status: 'accepted',
        createdAt: now,
      },
    });
    if (record.serverSeq > maxSeq) maxSeq = record.serverSeq;
  }
  return maxSeq;
}
