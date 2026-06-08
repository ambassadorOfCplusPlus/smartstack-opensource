// Слияние операций синхронизации в мастер-БД (Фаза 2, S5.2).
//
// ЧИСТЫЕ функции: принимают Prisma.TransactionClient (tx) — вызываются ВНУТРИ
// уже открытой транзакции push (по операции за раз, атомарно). Тестируются с
// фейком tx без живой БД.
//
// Все эффекты на остатки идут ЧЕРЕЗ движки партионного учёта (../batches):
//  - приход → createBatch-семантика поверх BatchStore (как в documents/apply);
//  - списание → ПРЯМОЕ применение к УКАЗАННОЙ партии по UUID (детерминизм при
//    слиянии), без FIFO-подбора. Используются те же *Via-методы BatchStore
//    (decrementBatchQuantity / insertWriteoff / decrementProductQuantity), сам
//    движок writeoff.engine НЕ меняется.

import { Prisma } from '@prisma/client';
import { createPrismaBatchStore } from '../batches/prisma-store';
import { EPS, type BatchStore } from '../batches/types';
import type {
  BatchReceiptPayload,
  BatchWriteoffPayload,
  ProductUpdatePayload,
} from './types';

// Результат применения одной операции к мастер-БД.
export type MergeOutcome =
  | { kind: 'applied' }
  // Идемпотентный скип (batch_receipt с уже существующим id партии).
  | { kind: 'skipped'; reason: string }
  // Физический конфликт: списание больше доступного остатка. Частично
  // списываем сколько есть, разницу фиксируем как shortage (status='conflict');
  // уведомление admin+keeper — в SyncService через ConflictService (S7.2).
  | { kind: 'conflict'; shortage: number; requested: number; available: number }
  // Поле заморожено открытым голосованием (S7.3) — правка отклоняется до
  // разрешения конфликта.
  | { kind: 'frozen'; conflictId: string };

// ─────────────────────────────────────────────────────────────────────────────
// batch_receipt: создать партию с ЗАДАННЫМ id (UUID с десктопа) + инкремент
// products.quantity. Если партия с таким id уже есть — идемпотентный скип.
// ─────────────────────────────────────────────────────────────────────────────
export async function applyBatchReceipt(
  tx: Prisma.TransactionClient,
  batchId: string,
  payload: BatchReceiptPayload,
): Promise<MergeOutcome> {
  const existing = await tx.batch.findUnique({ where: { id: batchId } });
  if (existing) {
    // Партия уже создана (повтор операции либо иная операция с тем же id) —
    // не применяем повторно (иначе задвоится остаток).
    return { kind: 'skipped', reason: 'batch already exists' };
  }

  const store = createPrismaBatchStore(tx);
  await tx.batch.create({
    data: {
      id: batchId,
      productId: payload.productId,
      warehouseId: payload.warehouseId,
      quantity: new Prisma.Decimal(payload.quantity.toFixed(3)),
      reserved: new Prisma.Decimal(0),
      costPrice: new Prisma.Decimal(payload.costPrice.toFixed(2)),
      // Валюта закупки + курс к рублю (костпрайс уже в рублях). Дефолты RUB/1.
      costCurrency: payload.costCurrency ?? 'RUB',
      fxRate: new Prisma.Decimal((payload.fxRate ?? 1).toString()),
      receivedAt: payload.receivedAt ? new Date(payload.receivedAt) : new Date(),
      expiryDate: payload.expiryDate ? new Date(payload.expiryDate) : null,
      status: 'active',
    },
  });
  await store.incrementProductQuantity(payload.productId, payload.quantity);

  return { kind: 'applied' };
}

// ─────────────────────────────────────────────────────────────────────────────
// batch_writeoff: списать С КОНКРЕТНОЙ партии (по batchId). Детерминизм —
// без FIFO-подбора. Уменьшаем quantity партии (обнуление → exhausted через
// store.decrementBatchQuantity), пишем BatchWriteoff, декремент products.quantity.
//
// Физический конфликт: доступно меньше qty → списываем сколько есть (частично),
// разницу возвращаем как shortage. НЕ откатываем (частичное списание допустимо
// на S5; полная недостача+уведомление — S7).
// ─────────────────────────────────────────────────────────────────────────────
export async function applyBatchWriteoff(
  tx: Prisma.TransactionClient,
  payload: BatchWriteoffPayload,
  userId: string,
): Promise<MergeOutcome> {
  const store: BatchStore = createPrismaBatchStore(tx);

  const batch = await tx.batch.findUnique({ where: { id: payload.batchId } });
  if (!batch) {
    // Партии нет: трактуем как полную нехватку (физический конфликт).
    // TODO(S7): зафиксировать недостачу + уведомление admin/keeper.
    return {
      kind: 'conflict',
      shortage: payload.quantity,
      requested: payload.quantity,
      available: 0,
    };
  }

  // Доступно к списанию с КОНКРЕТНОЙ партии = quantity - reserved.
  const available = batch.quantity.toNumber() - batch.reserved.toNumber();
  const requested = payload.quantity;
  const toWriteoff = Math.min(requested, Math.max(0, available));
  const shortage = requested - toWriteoff;

  if (toWriteoff > EPS) {
    // ВАЖНО: применяем через методы BatchStore (тот же путь, что и движок),
    // но к УКАЗАННОЙ партии — без подбора.
    await store.decrementBatchQuantity(payload.batchId, toWriteoff);
    await store.insertWriteoff({
      batchId: payload.batchId,
      quantity: toWriteoff,
      costPrice: batch.costPrice.toNumber(),
      reason: payload.reason,
      documentId: null,
      userId,
    });
    await store.decrementProductQuantity(payload.productId, toWriteoff);
  }

  if (shortage > EPS) {
    // TODO(S7): создать недостачу + уведомление admin/keeper «инвентаризация».
    return { kind: 'conflict', shortage, requested, available: Math.max(0, available) };
  }

  return { kind: 'applied' };
}

// ─────────────────────────────────────────────────────────────────────────────
// product_update: обновить ОДНО поле товара (поле уже провалидировано whitelist'ом
// в schema). Детекция конфликтов по vector clock — НЕ здесь (S7, TODO).
// ─────────────────────────────────────────────────────────────────────────────
export async function applyProductUpdate(
  tx: Prisma.TransactionClient,
  productId: string,
  payload: ProductUpdatePayload,
): Promise<MergeOutcome> {
  // S7.3: поле заморожено открытым голосованием → правка отклоняется.
  const frozen = await tx.conflictVote.findMany({
    where: {
      entityType: 'product',
      entityId: productId,
      field: payload.field,
      status: 'open',
    },
  });
  if (frozen.length > 0) {
    return { kind: 'frozen', conflictId: frozen[0].id };
  }
  // Детекция КОНКУРРЕНТНОЙ правки (vector clocks) — уровнем выше, в
  // SyncService.push (нужен доступ к последней принятой операции по полю).
  const data: Record<string, unknown> = {};
  switch (payload.field) {
    case 'name':
      data.name = payload.value as string;
      break;
    case 'barcode':
      data.barcode = (payload.value as string | null) ?? null;
      break;
    case 'unit':
      data.unit = payload.value as string;
      break;
    case 'price':
      data.price = new Prisma.Decimal((payload.value as number).toFixed(2));
      break;
    case 'minStock':
      data.minStock = new Prisma.Decimal((payload.value as number).toFixed(3));
      break;
  }
  await tx.product.update({ where: { id: productId }, data });
  return { kind: 'applied' };
}
