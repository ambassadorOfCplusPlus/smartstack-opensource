// Тесты движка списания (порт WriteoffEngine.cpp), БЕЗ БД.
// Используется in-memory FakeBatchStore + эмуляция транзакции с откатом.

import { describe, it, expect } from 'vitest';
import {
  applyWriteoff,
  computePlan,
  getAvailableQtyVia,
  getWeightedAverageCostVia,
} from './writeoff.engine';
import { makeState, FakeBatchStore, withTransaction, type FakeState } from './fake-store';

// Хелпер: партия.
function batch(
  id: string,
  opts: Partial<{
    productId: string;
    warehouseId: string;
    quantity: number;
    reserved: number;
    costPrice: number;
    receivedAt: number;
    status: 'active' | 'exhausted' | 'expired';
  }> = {},
) {
  return {
    id,
    productId: opts.productId ?? 'P1',
    warehouseId: opts.warehouseId ?? 'W1',
    quantity: opts.quantity ?? 10,
    reserved: opts.reserved ?? 0,
    costPrice: opts.costPrice ?? 100,
    receivedAt: opts.receivedAt ?? 1000,
    status: opts.status ?? ('active' as const),
  };
}

function baseState(): FakeState {
  return makeState({
    products: [{ id: 'P1', quantity: 30 }],
    batches: [
      batch('B1', { quantity: 10, costPrice: 100, receivedAt: 1000 }),
      batch('B2', { quantity: 10, costPrice: 200, receivedAt: 2000 }),
      batch('B3', { quantity: 10, costPrice: 300, receivedAt: 3000 }),
    ],
  });
}

describe('WriteoffEngine FIFO', () => {
  it('списывает из первой (самой старой) партии', async () => {
    const state = baseState();
    const res = await withTransaction(state, (s) =>
      applyWriteoff(s, {
        productId: 'P1',
        warehouseId: 'W1',
        quantity: 5,
        method: 'FIFO',
        reason: 'sale',
        userId: 'U1',
      }),
    );
    expect(res.success).toBe(true);
    expect(res.items).toEqual([
      { batchId: 'B1', quantity: 5, costPrice: 100, costCurrency: 'RUB', fxRate: 1 },
    ]);
    expect(res.totalCost).toBe(500);
    expect(state.batches.find((b) => b.id === 'B1')!.quantity).toBe(5);
  });

  it('span двух партий (FIFO порядок по received_at)', async () => {
    const state = baseState();
    const res = await withTransaction(state, (s) =>
      applyWriteoff(s, {
        productId: 'P1',
        warehouseId: 'W1',
        quantity: 15,
        method: 'FIFO',
        reason: 'sale',
        userId: 'U1',
      }),
    );
    expect(res.items).toEqual([
      { batchId: 'B1', quantity: 10, costPrice: 100, costCurrency: 'RUB', fxRate: 1 },
      { batchId: 'B2', quantity: 5, costPrice: 200, costCurrency: 'RUB', fxRate: 1 },
    ]);
    expect(res.totalCost).toBe(2000); // 10*100 + 5*200
  });

  it('точное обнуление партии → status exhausted', async () => {
    const state = baseState();
    await withTransaction(state, (s) =>
      applyWriteoff(s, {
        productId: 'P1',
        warehouseId: 'W1',
        quantity: 10,
        method: 'FIFO',
        reason: 'sale',
        userId: 'U1',
      }),
    );
    const b1 = state.batches.find((b) => b.id === 'B1')!;
    expect(b1.quantity).toBe(0);
    expect(b1.status).toBe('exhausted');
  });

  it('недостаточно остатка → ошибка и состояние НЕ изменилось (rollback)', async () => {
    const state = baseState();
    const before = JSON.stringify(state);
    let result;
    try {
      result = await withTransaction(state, (s) =>
        applyWriteoff(s, {
          productId: 'P1',
          warehouseId: 'W1',
          quantity: 999,
          method: 'FIFO',
          reason: 'sale',
          userId: 'U1',
        }),
      );
    } catch (e) {
      result = e as Error & { code?: string };
    }
    expect((result as Error & { code?: string }).code).toBe('INSUFFICIENT_STOCK');
    // Полный откат: никаких списаний, остатки прежние.
    expect(JSON.stringify(state)).toBe(before);
    expect(state.writeoffs).toHaveLength(0);
  });

  it('warehouseId фильтр ограничивает подбор партий', async () => {
    const state = makeState({
      products: [{ id: 'P1', quantity: 20 }],
      batches: [
        batch('B1', { warehouseId: 'W1', quantity: 10, costPrice: 100 }),
        batch('B2', { warehouseId: 'W2', quantity: 10, costPrice: 200 }),
      ],
    });
    const store = new FakeBatchStore(state);
    // По складу W1 доступно только 10.
    const plan = await computePlan(store, 'P1', 5, 'FIFO', 'W1');
    expect(plan.items).toEqual([
      { batchId: 'B1', quantity: 5, costPrice: 100, costCurrency: 'RUB', fxRate: 1 },
    ]);
    // Запрос 15 по W1 — не хватит.
    const plan2 = await computePlan(store, 'P1', 15, 'FIFO', 'W1');
    expect(plan2.success).toBe(false);
    expect(plan2.error).toBe('INSUFFICIENT_STOCK');
  });

  it('резерв уменьшает доступное (quantity - reserved)', async () => {
    const state = makeState({
      products: [{ id: 'P1', quantity: 10 }],
      batches: [batch('B1', { quantity: 10, reserved: 7, costPrice: 100 })],
    });
    const store = new FakeBatchStore(state);
    // Доступно 3; запрос 5 — недостаточно.
    const plan = await computePlan(store, 'P1', 5, 'FIFO');
    expect(plan.success).toBe(false);
    // Запрос 3 — ок.
    const plan2 = await computePlan(store, 'P1', 3, 'FIFO');
    expect(plan2.success).toBe(true);
    expect(plan2.items[0]).toEqual({
      batchId: 'B1',
      quantity: 3,
      costPrice: 100,
      costCurrency: 'RUB',
      fxRate: 1,
    });
  });

  it('batch_writeoffs создаются с верными cost_price и products.quantity уменьшается', async () => {
    const state = baseState();
    await withTransaction(state, (s) =>
      applyWriteoff(s, {
        productId: 'P1',
        warehouseId: 'W1',
        quantity: 15,
        method: 'FIFO',
        reason: 'sale',
        documentId: 'D1',
        userId: 'U1',
      }),
    );
    expect(state.writeoffs).toHaveLength(2);
    expect(state.writeoffs[0]).toMatchObject({ batchId: 'B1', costPrice: 100, reason: 'sale', documentId: 'D1', userId: 'U1' });
    expect(state.writeoffs[1]).toMatchObject({ batchId: 'B2', costPrice: 200 });
    // Кэш остатка: 30 - 15 = 15.
    expect(state.products.find((p) => p.id === 'P1')!.quantity).toBe(15);
  });
});

describe('WriteoffEngine LIFO', () => {
  it('списывает из последней (самой новой) партии', async () => {
    const state = baseState();
    const res = await withTransaction(state, (s) =>
      applyWriteoff(s, {
        productId: 'P1',
        warehouseId: 'W1',
        quantity: 5,
        method: 'LIFO',
        reason: 'sale',
        userId: 'U1',
      }),
    );
    expect(res.items).toEqual([
      { batchId: 'B3', quantity: 5, costPrice: 300, costCurrency: 'RUB', fxRate: 1 },
    ]);
  });

  it('span двух партий (LIFO порядок по received_at DESC)', async () => {
    const state = baseState();
    const res = await withTransaction(state, (s) =>
      applyWriteoff(s, {
        productId: 'P1',
        warehouseId: 'W1',
        quantity: 15,
        method: 'LIFO',
        reason: 'sale',
        userId: 'U1',
      }),
    );
    expect(res.items).toEqual([
      { batchId: 'B3', quantity: 10, costPrice: 300, costCurrency: 'RUB', fxRate: 1 },
      { batchId: 'B2', quantity: 5, costPrice: 200, costCurrency: 'RUB', fxRate: 1 },
    ]);
  });
});

describe('WriteoffEngine WeightedAverage', () => {
  it('правильная средняя себестоимость: 10шт@100 + 10шт@200 → 150', async () => {
    const state = makeState({
      products: [{ id: 'P1', quantity: 20 }],
      batches: [
        batch('B1', { quantity: 10, costPrice: 100, receivedAt: 1000 }),
        batch('B2', { quantity: 10, costPrice: 200, receivedAt: 2000 }),
      ],
    });
    const store = new FakeBatchStore(state);
    expect(await getWeightedAverageCostVia(store, 'P1')).toBe(150);
  });

  it('списывает qty пропорционально долям партий, cost = средневзвешенная', async () => {
    const state = makeState({
      products: [{ id: 'P1', quantity: 20 }],
      batches: [
        batch('B1', { quantity: 10, costPrice: 100, receivedAt: 1000 }),
        batch('B2', { quantity: 10, costPrice: 200, receivedAt: 2000 }),
      ],
    });
    const res = await withTransaction(state, (s) =>
      applyWriteoff(s, {
        productId: 'P1',
        warehouseId: 'W1',
        quantity: 10,
        method: 'WeightedAverage',
        reason: 'sale',
        userId: 'U1',
      }),
    );
    expect(res.success).toBe(true);
    expect(res.averageCost).toBe(150);
    // Доли: 10*10/20 = 5 из каждой партии; cost каждой строки = 150.
    expect(res.items).toEqual([
      { batchId: 'B1', quantity: 5, costPrice: 150, costCurrency: 'RUB', fxRate: 1 },
      { batchId: 'B2', quantity: 5, costPrice: 150, costCurrency: 'RUB', fxRate: 1 },
    ]);
    expect(res.totalCost).toBe(1500); // 10 * 150
    // Физически списано из обеих партий.
    expect(state.batches.find((b) => b.id === 'B1')!.quantity).toBe(5);
    expect(state.batches.find((b) => b.id === 'B2')!.quantity).toBe(5);
    expect(state.products.find((p) => p.id === 'P1')!.quantity).toBe(10);
  });

  it('остаток округления отдаётся последней значимой партии (сумма = qty)', async () => {
    const state = makeState({
      products: [{ id: 'P1', quantity: 30 }],
      batches: [
        batch('B1', { quantity: 10, costPrice: 100, receivedAt: 1000 }),
        batch('B2', { quantity: 10, costPrice: 100, receivedAt: 2000 }),
        batch('B3', { quantity: 10, costPrice: 100, receivedAt: 3000 }),
      ],
    });
    const res = await withTransaction(state, (s) =>
      applyWriteoff(s, {
        productId: 'P1',
        warehouseId: 'W1',
        quantity: 10,
        method: 'WeightedAverage',
        reason: 'sale',
        userId: 'U1',
      }),
    );
    const total = res.items.reduce((acc, x) => acc + x.quantity, 0);
    expect(total).toBeCloseTo(10, 6);
  });
});

describe('WriteoffEngine справочные расчёты', () => {
  it('getAvailableQty = SUM(quantity - reserved) по активным партиям', async () => {
    const state = makeState({
      products: [{ id: 'P1', quantity: 0 }],
      batches: [
        batch('B1', { quantity: 10, reserved: 2 }),
        batch('B2', { quantity: 5, reserved: 0 }),
        batch('B3', { quantity: 100, reserved: 0, status: 'exhausted' }),
      ],
    });
    const store = new FakeBatchStore(state);
    // (10-2) + (5-0) = 13; exhausted не считается.
    expect(await getAvailableQtyVia(store, 'P1')).toBe(13);
  });

  it('getWeightedAverageCost учитывает только доступный остаток', async () => {
    const state = makeState({
      products: [{ id: 'P1', quantity: 0 }],
      batches: [
        batch('B1', { quantity: 10, reserved: 0, costPrice: 100 }),
        batch('B2', { quantity: 10, reserved: 5, costPrice: 200 }),
      ],
    });
    const store = new FakeBatchStore(state);
    // (100*10 + 200*5) / (10+5) = 2000/15 = 133.33
    expect(await getWeightedAverageCostVia(store, 'P1')).toBe(133.33);
  });
});
