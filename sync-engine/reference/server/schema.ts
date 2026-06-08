// Zod-схемы входных данных модуля синхронизации (Фаза 2, S5).
//
// Каждая операция валидируется ПО ОТДЕЛЬНОСТИ внутри push (невалидная →
// rejected, остальные продолжают), поэтому из общей body-схемы операции
// разбираются как «сырой» массив, а строгий разбор операции — operationSchema.

import { z } from 'zod';
import { WriteoffReason } from '@prisma/client';

// Вектор часов: deviceId(UUID) → неотрицательное целое.
export const vectorClockSchema = z.record(z.string(), z.number().int().nonnegative());

// --- payload по типам ---

export const batchReceiptPayloadSchema = z.object({
  productId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity: z.number().positive(),
  costPrice: z.number().nonnegative(),
  receivedAt: z.string().datetime().optional(),
  expiryDate: z.string().datetime().optional(),
  // Валюта закупки и курс к рублю (контракт с десктопом). costPrice ВСЕГДА в
  // рублях; отсутствие полей = "RUB"/1. Семантику costPrice не меняем.
  costCurrency: z.string().min(1).max(10).optional(),
  fxRate: z.number().positive().optional(),
});

export const batchWriteoffPayloadSchema = z.object({
  batchId: z.string().uuid(),
  productId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity: z.number().positive(),
  reason: z.nativeEnum(WriteoffReason),
});

// Whitelist полей товара + типизация значения по полю.
export const productUpdatePayloadSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('name'), value: z.string().min(1).max(500), prevValue: z.unknown().optional() }),
  z.object({ field: z.literal('price'), value: z.number().nonnegative(), prevValue: z.unknown().optional() }),
  z.object({ field: z.literal('minStock'), value: z.number().nonnegative(), prevValue: z.unknown().optional() }),
  z.object({ field: z.literal('barcode'), value: z.string().max(200).nullable(), prevValue: z.unknown().optional() }),
  z.object({ field: z.literal('unit'), value: z.string().min(1).max(50), prevValue: z.unknown().optional() }),
]);

// --- операция (discriminated по operation) ---
// entityType сверяется с operation внутри: receipt/writeoff → 'batch',
// product_update → 'product'.

const baseFields = {
  id: z.string().uuid(),
  entityId: z.string().uuid(),
  vectorClock: vectorClockSchema,
  createdAt: z.string().datetime(),
};

export const operationSchema = z
  .discriminatedUnion('operation', [
    z.object({
      ...baseFields,
      entityType: z.literal('batch'),
      operation: z.literal('batch_receipt'),
      payload: batchReceiptPayloadSchema,
    }),
    z.object({
      ...baseFields,
      entityType: z.literal('batch'),
      operation: z.literal('batch_writeoff'),
      payload: batchWriteoffPayloadSchema,
    }),
    z.object({
      ...baseFields,
      entityType: z.literal('product'),
      operation: z.literal('product_update'),
      payload: productUpdatePayloadSchema,
    }),
  ]);

export type ValidatedOperation = z.infer<typeof operationSchema>;

// Тело POST /sync/push. operations разбираем как unknown[] — каждую операцию
// валидируем индивидуально, чтобы одна кривая не уронила всю пачку.
export const pushBodySchema = z.object({
  deviceId: z.string().uuid(),
  operations: z.array(z.unknown()).max(1000),
});
export type PushBody = z.infer<typeof pushBodySchema>;

// Query GET /sync/pull: since — строка-число (BigInt не влезает в number),
// deviceId — НЕ отдавать его собственные операции, limit — размер страницы.
export const pullQuerySchema = z.object({
  since: z.string().regex(/^\d+$/, 'since: ожидается число').default('0'),
  deviceId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type PullQuery = z.infer<typeof pullQuerySchema>;

// Query GET /sync/snapshot: снимок конкретного склада.
export const snapshotQuerySchema = z.object({
  warehouseId: z.string().uuid(),
});
export type SnapshotQuery = z.infer<typeof snapshotQuerySchema>;

// --- S7: конфликты и голосование ---

export const conflictsQuerySchema = z.object({
  status: z.enum(['open', 'resolved', 'cancelled']).optional(),
});

export const voteBodySchema = z.object({
  choice: z.enum(['a', 'b']),
});

export const resolveConflictSchema = z.object({
  conflictId: z.string().uuid(),
  mode: z.enum(['majority', 'veto']),
  choice: z.enum(['a', 'b']).optional(),
});
