// Движок списания партий (порт WriteoffEngine из десктопа, src/inventory/WriteoffEngine.cpp).
//
// Storage-agnostic: работает не с конкретной БД, а через интерфейс BatchStore.
// Семантика 1:1 с C++ оригиналом:
//  - подбор партий: status='active' И (quantity - reserved) > eps, фильтр по складу;
//  - FIFO: ORDER BY received_at ASC, id ASC; LIFO: received_at DESC, id DESC;
//  - WeightedAverage: НЕ списывает физически FIFO — распределяет qty ПРОПОРЦИОНАЛЬНО
//    долям доступного остатка всех активных партий, cost_price каждой строки =
//    средневзвешенная цена; остаток округления отдаётся последней значимой партии
//    (как computePlan() в C++);
//  - недостаточно остатка → INSUFFICIENT_STOCK, БЕЗ частичного списания (вся
//    транзакция откатывается);
//  - обнулённая партия → status='exhausted';
//  - каждое списание → запись batch_writeoffs;
//  - после — декремент кэша products.quantity.
//
// Транзакционность обеспечивает вызывающий код: applyWriteoff выполняется уже
// ВНУТРИ открытой транзакции переданного BatchStore. При INSUFFICIENT_STOCK
// бросается исключение, чтобы внешняя транзакция откатилась без частичного списания.

import {
  EPS,
  type BatchStore,
  type WriteoffMethod,
  type WriteoffReason,
  type WriteoffResult,
  type WriteoffLineResult,
  type BatchRow,
} from './types';

// Округление денег до 2 знаков (как toFixed(2) семантика для NUMERIC(15,2)).
function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

// Доступный остаток партии (как (quantity - reserved) в SQL C++).
function available(b: BatchRow): number {
  return b.quantity - b.reserved;
}

export interface WriteoffParams {
  productId: string;
  warehouseId?: string;
  quantity: number;
  reason: WriteoffReason;
  method: WriteoffMethod;
  documentId?: string | null;
  userId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Подбор партий + расчёт строк списания (как WriteoffEngine::computePlan).
// Только расчёт, без записи. success=false при нехватке остатка.
// ─────────────────────────────────────────────────────────────────────────────
export async function computePlan(
  store: BatchStore,
  productId: string,
  quantity: number,
  method: WriteoffMethod,
  warehouseId?: string,
): Promise<WriteoffResult> {
  const order =
    method === 'FIFO'
      ? 'received_asc'
      : method === 'LIFO'
        ? 'received_desc'
        : 'none';

  const rows = await store.findActiveBatches({ productId, warehouseId }, order);

  const totalAvail = rows.reduce((s, r) => s + available(r), 0);

  // Недостаточно остатка (как totalAvail + kEps < quantity).
  if (totalAvail + EPS < quantity) {
    return {
      success: false,
      totalCost: 0,
      averageCost: 0,
      items: [],
      error: 'INSUFFICIENT_STOCK',
      errorMessage: `Недостаточно остатка: доступно ${totalAvail}, запрошено ${quantity}`,
    };
  }

  const items: WriteoffLineResult[] = [];
  let totalCost = 0;

  if (method === 'WeightedAverage') {
    // Средневзвешенная цена доступного остатка (как weighted/totalAvail в C++).
    const weighted = rows.reduce((s, r) => s + r.costPrice * available(r), 0);
    const avg = totalAvail > EPS ? weighted / totalAvail : 0;

    // Индекс последней значимой партии — ей отдаём остаток округления.
    let lastIdx = rows.length;
    for (let i = 0; i < rows.length; i++) {
      if (available(rows[i]!) > EPS) lastIdx = i;
    }

    let allocated = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const avail = available(row);
      if (avail <= EPS) continue;
      let share =
        i === lastIdx ? quantity - allocated : (quantity * avail) / totalAvail;
      // Не списываем из партии больше, чем в ней есть (иначе остаток партии ушёл
      // бы в минус из-за добора округления в последнюю строку).
      share = Math.min(share, avail);
      if (share <= EPS) continue;
      allocated += share;
      const cost = round2(avg);
      items.push({
        batchId: row.id,
        quantity: share,
        costPrice: cost,
        costCurrency: row.costCurrency,
        fxRate: row.fxRate,
      });
      totalCost += share * cost;
    }
    return {
      success: true,
      items,
      totalCost: round2(totalCost),
      averageCost: round2(avg),
    };
  }

  // FIFO / LIFO: берём партии по порядку, пока не наберём quantity.
  let remaining = quantity;
  for (const row of rows) {
    if (remaining <= EPS) break;
    const take = Math.min(remaining, available(row));
    if (take <= EPS) continue;
    const cost = round2(row.costPrice);
    items.push({
      batchId: row.id,
      quantity: take,
      costPrice: cost,
      costCurrency: row.costCurrency,
      fxRate: row.fxRate,
    });
    totalCost += take * cost;
    remaining -= take;
  }
  const avgCost = quantity > EPS ? totalCost / quantity : 0;
  return {
    success: true,
    items,
    totalCost: round2(totalCost),
    averageCost: round2(avgCost),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Расчёт + применение к хранилищу через переданный store.
// Вызывается уже ВНУТРИ транзакции. При INSUFFICIENT_STOCK бросает, чтобы
// внешняя транзакция откатилась без частичного списания (как Transaction в C++).
// ─────────────────────────────────────────────────────────────────────────────
export async function applyWriteoff(
  store: BatchStore,
  params: WriteoffParams,
): Promise<WriteoffResult> {
  const { productId, warehouseId, quantity, method, reason, documentId, userId } =
    params;

  const plan = await computePlan(store, productId, quantity, method, warehouseId);
  if (!plan.success) {
    // Бросаем, чтобы откатить транзакцию (никаких частичных изменений).
    const err = new Error(plan.errorMessage ?? plan.error ?? 'writeoff failed');
    (err as Error & { code?: string }).code = plan.error;
    throw err;
  }

  for (const line of plan.items) {
    // Уменьшаем остаток партии; при обнулении → status='exhausted'.
    await store.decrementBatchQuantity(line.batchId, line.quantity);
    // Фиксируем движение списания.
    await store.insertWriteoff({
      batchId: line.batchId,
      quantity: line.quantity,
      costPrice: line.costPrice,
      reason,
      documentId: documentId ?? null,
      userId,
    });
  }

  // Обновляем денормализованный кэш остатка товара.
  await store.decrementProductQuantity(productId, quantity);

  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────
// Справочные расчёты (как availableQuantity / weightedAverageCost в C++).
// Только чтение — работают через store.
// ─────────────────────────────────────────────────────────────────────────────

export async function getAvailableQtyVia(
  store: BatchStore,
  productId: string,
  warehouseId?: string,
): Promise<number> {
  // Все активные партии (status='active'), сумма (quantity - reserved).
  const rows = await store.findActiveBatches({ productId, warehouseId }, 'none');
  return rows.reduce((s, r) => s + available(r), 0);
}

export async function getWeightedAverageCostVia(
  store: BatchStore,
  productId: string,
  warehouseId?: string,
): Promise<number> {
  const rows = await store.findActiveBatches({ productId, warehouseId }, 'none');
  const totalAvail = rows.reduce((s, r) => s + available(r), 0);
  if (totalAvail <= EPS) return 0;
  const weighted = rows.reduce((s, r) => s + r.costPrice * available(r), 0);
  return round2(weighted / totalAvail);
}

export { round2 };
