// Движок применения операций журнала — ТЕКУЩИЙ стек оригинала SmartStock.
//
// Портирован по семантике из десктопа:
//   include/core/sync/SyncEngine.hpp + src/core/sync/SyncEngine.cpp.
//
// Принимает уже расшифрованный пакет операций (SyncOp[], см. codec) и:
//   • дедуплицирует по op_id (идемпотентность повторной доставки реле/P2P),
//   • диспетчеризует по типу в прикладной слой (ISyncApplier),
//   • собирает по-операционный результат (applied/duplicate/rejected/…).
//
// Успешно применённые op_id запоминаются в дедупе; ОТКЛОНЁННЫЕ — НЕТ (чтобы
// операция могла повториться позже, когда условие изменится — напр. появился
// остаток). В десктопе дедуп-claim идёт в ТОЙ ЖЕ транзакции, что и операция
// (таблица applied_ops) — повтор не применяется дважды даже при крахе между
// коммитами; здесь — storage-agnostic интерфейс + in-memory реализация.

import type { SyncOp } from './codec';

// Известные типы операций журнала (изменяющие состояние).
export const optype = {
  receive: 'receive', // приёмка партии
  writeoff: 'writeoff', // списание
  inventoryCount: 'inventory_count', // пересчёт ИНВ
  priceChange: 'price_change', // смена цены
  createProduct: 'create_product', // создание товара с телефона
  snapshot: 'snapshot', // снимок каталога (десктоп→телефон, только просмотр)
} as const;

export type ApplyStatus =
  | 'applied' // проведено прикладным слоем
  | 'duplicate' // op_id уже применялся ранее (идемпотентно пропущено)
  | 'rejected' // прикладной слой отклонил (напр. недостаточно остатка)
  | 'unknown_type' // неизвестный тип операции
  | 'bad_op'; // некорректная операция (пустой op_id и т.п.)

export interface OpResult {
  opId: string;
  status: ApplyStatus;
  message: string; // человекочитаемая причина при отказе
}

// Итог применения одной операции прикладным слоем.
export interface ApplyOutcome {
  ok: boolean;
  message?: string; // причина при !ok
  // ok, но операция уже применялась (no-op): считать duplicate, а не applied —
  // иначе ложный сигнал об изменении данных/обновление UI.
  duplicate?: boolean;
}

// Граница к слою данных. Реализация проводит операцию через штатные сервисы
// (партии FIFO, транзакции, availableForSale, audit_log). opId передаётся как
// ключ идемпотентности проведения (claim в applied_ops в той же транзакции).
export interface ISyncApplier {
  receive(opId: string, data: unknown): ApplyOutcome | Promise<ApplyOutcome>;
  writeoff(opId: string, data: unknown): ApplyOutcome | Promise<ApplyOutcome>;
  inventoryCount(opId: string, data: unknown): ApplyOutcome | Promise<ApplyOutcome>;
  priceChange(opId: string, data: unknown): ApplyOutcome | Promise<ApplyOutcome>;
  createProduct(opId: string, data: unknown): ApplyOutcome | Promise<ApplyOutcome>;
}

// Хранилище уже применённых op_id (идемпотентность). В десктопе — сайдкар sync.db.
export interface IDedupStore {
  seen(opId: string): boolean;
  remember(opId: string): void;
}

// In-memory дедуп-стор для тестов и лёгких сценариев (Node однопоточен в рамках
// тика — синхронной реализации достаточно).
export class InMemoryDedupStore implements IDedupStore {
  private readonly ids = new Set<string>();
  seen(opId: string): boolean {
    return this.ids.has(opId);
  }
  remember(opId: string): void {
    this.ids.add(opId);
  }
}

// Диспетчер по типу операции.
function dispatch(applier: ISyncApplier, op: SyncOp): ApplyOutcome | Promise<ApplyOutcome> {
  switch (op.type) {
    case optype.receive:
      return applier.receive(op.opId, op.data);
    case optype.writeoff:
      return applier.writeoff(op.opId, op.data);
    case optype.inventoryCount:
      return applier.inventoryCount(op.opId, op.data);
    case optype.priceChange:
      return applier.priceChange(op.opId, op.data);
    case optype.createProduct:
      return applier.createProduct(op.opId, op.data);
    default:
      return { ok: false, message: `неизвестный тип: ${op.type}` };
  }
}

// Применить пакет операций. Порядок результатов соответствует порядку ops.
// Дедуп по op_id: повтор возвращает 'duplicate' и НЕ зовёт прикладной слой.
export async function applyBatch(
  ops: SyncOp[],
  applier: ISyncApplier,
  dedup: IDedupStore,
): Promise<OpResult[]> {
  const results: OpResult[] = [];
  for (const op of ops) {
    // 1. Некорректная операция (нет op_id) — не применяем.
    if (!op.opId) {
      results.push({ opId: op.opId, status: 'bad_op', message: 'пустой op_id' });
      continue;
    }
    // 2. Уже применяли эту операцию (идемпотентность повторной доставки).
    if (dedup.seen(op.opId)) {
      results.push({ opId: op.opId, status: 'duplicate', message: '' });
      continue;
    }
    // 3. Снимок — не изменяющая операция для этого движка (обслуживается снимком).
    if (op.type === optype.snapshot) {
      results.push({ opId: op.opId, status: 'unknown_type', message: 'снимок не применяется движком' });
      continue;
    }
    // 4. Известный изменяющий тип?
    const known: string[] = [
      optype.receive,
      optype.writeoff,
      optype.inventoryCount,
      optype.priceChange,
      optype.createProduct,
    ];
    if (!known.includes(op.type)) {
      results.push({ opId: op.opId, status: 'unknown_type', message: `неизвестный тип: ${op.type}` });
      continue;
    }
    // 5. Провести через прикладной слой.
    const outcome = await dispatch(applier, op);
    if (outcome.ok) {
      // Успех (в т.ч. no-op-дубль на уровне слоя данных) — запоминаем op_id.
      dedup.remember(op.opId);
      results.push({
        opId: op.opId,
        status: outcome.duplicate ? 'duplicate' : 'applied',
        message: '',
      });
    } else {
      // ОТКЛОНЕНО — НЕ запоминаем (даём операции повториться позже).
      results.push({ opId: op.opId, status: 'rejected', message: outcome.message ?? '' });
    }
  }
  return results;
}
