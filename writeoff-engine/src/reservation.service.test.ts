// Тесты резервов под заказ (порт ReservationService.cpp), БЕЗ БД.
// In-memory FakeBatchStore + эмуляция транзакции с откатом (withTransaction).

import { describe, it, expect } from 'vitest';
import {
  reserve,
  confirm,
  cancel,
  expireOutdated,
  type Reservation,
} from './reservation.service';
import {
  makeState,
  FakeBatchStore,
  withTransaction,
  type FakeState,
} from './fake-store';

const NOW = 1_000_000; // фиксированное «сейчас» (epoch ms) для детерминизма TTL

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

describe('ReservationService.reserve', () => {
  it('FIFO-распределение резерва по партиям (B1 целиком + B2 частично)', async () => {
    const state = baseState();
    const out = await withTransaction(state, (s) =>
      reserve(
        s,
        { productId: 'P1', warehouseId: 'W1', quantity: 15, ttlMinutes: 60 },
        NOW,
      ),
    );

    expect(out.success).toBe(true);
    expect(out.availableQty).toBe(15); // 30 - 15
    const legs = out.reservation!.legs;
    expect(legs.map((l) => ({ batchId: l.batchId, quantity: l.quantity }))).toEqual([
      { batchId: 'B1', quantity: 10 },
      { batchId: 'B2', quantity: 5 },
    ]);

    // Удержание отражено в batches.reserved.
    expect(state.batches.find((b) => b.id === 'B1')!.reserved).toBe(10);
    expect(state.batches.find((b) => b.id === 'B2')!.reserved).toBe(5);
    expect(state.batches.find((b) => b.id === 'B3')!.reserved).toBe(0);

    // Две строки резерва, обе active, с общим expires_at = NOW + 60 мин.
    expect(state.reservations).toHaveLength(2);
    for (const r of state.reservations) {
      expect(r.status).toBe('active');
      expect(r.expiresAt).toBe(NOW + 60 * 60_000);
    }
  });

  it('TTL по умолчанию (60 мин), когда ttlMinutes не задан', async () => {
    const state = baseState();
    const out = await withTransaction(state, (s) =>
      reserve(s, { productId: 'P1', warehouseId: 'W1', quantity: 5 }, NOW),
    );
    expect(out.reservation!.expiresAt).toBe(NOW + 60 * 60_000);
  });

  it('нехватка остатка → отказ БЕЗ частичного резерва (состояние не изменилось)', async () => {
    const state = baseState();
    const before = JSON.stringify(state);
    const out = await withTransaction(state, (s) =>
      reserve(s, { productId: 'P1', warehouseId: 'W1', quantity: 999 }, NOW),
    );
    expect(out.success).toBe(false);
    expect(out.error).toBe('INSUFFICIENT_STOCK');
    expect(out.availableQty).toBe(30);
    // Никаких удержаний / строк резерва — состояние идентично.
    expect(JSON.stringify(state)).toBe(before);
    expect(state.reservations).toHaveLength(0);
  });

  it('фильтр по складу ограничивает доступное для резерва', async () => {
    const state = makeState({
      products: [{ id: 'P1', quantity: 20 }],
      batches: [
        batch('B1', { warehouseId: 'W1', quantity: 10 }),
        batch('B2', { warehouseId: 'W2', quantity: 10 }),
      ],
    });
    // По W1 доступно только 10 → запрос 15 не проходит.
    const out = await withTransaction(state, (s) =>
      reserve(s, { productId: 'P1', warehouseId: 'W1', quantity: 15 }, NOW),
    );
    expect(out.success).toBe(false);
    expect(out.error).toBe('INSUFFICIENT_STOCK');
  });
});

describe('ReservationService.confirm', () => {
  it('атомарно списывает именно зарезервированное и переводит резерв в confirmed', async () => {
    const state = baseState();
    const out = await withTransaction(state, (s) =>
      reserve(
        s,
        { productId: 'P1', warehouseId: 'W1', quantity: 15, ttlMinutes: 60 },
        NOW,
      ),
    );
    const reservation = out.reservation!;

    const ok = await withTransaction(state, (s) =>
      confirm(s, reservation, 'FIFO', { userId: 'U1', nowMs: NOW }),
    );
    expect(ok).toBe(true);

    // Списано FIFO ровно 15: B1 (10) обнулилась, B2 (5) осталось 5.
    expect(state.batches.find((b) => b.id === 'B1')!.quantity).toBe(0);
    expect(state.batches.find((b) => b.id === 'B1')!.status).toBe('exhausted');
    expect(state.batches.find((b) => b.id === 'B2')!.quantity).toBe(5);
    // Удержание снято на всех партиях.
    for (const b of state.batches) expect(b.reserved).toBe(0);
    // Кэш остатка товара: 30 - 15 = 15.
    expect(state.products.find((p) => p.id === 'P1')!.quantity).toBe(15);
    // Движения списания зафиксированы.
    expect(state.writeoffs).toHaveLength(2);
    // Все ноги резерва — confirmed.
    for (const r of state.reservations) expect(r.status).toBe('confirmed');
  });

  it('повторный confirm возвращает false и ничего не меняет', async () => {
    const state = baseState();
    const out = await withTransaction(state, (s) =>
      reserve(s, { productId: 'P1', warehouseId: 'W1', quantity: 5 }, NOW),
    );
    const reservation = out.reservation!;
    await withTransaction(state, (s) =>
      confirm(s, reservation, 'FIFO', { nowMs: NOW }),
    );

    const before = JSON.stringify(state);
    const second = await withTransaction(state, (s) =>
      confirm(s, reservation, 'FIFO', { nowMs: NOW }),
    );
    expect(second).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('истёкший резерв не подтверждается (false)', async () => {
    const state = baseState();
    const out = await withTransaction(state, (s) =>
      reserve(
        s,
        { productId: 'P1', warehouseId: 'W1', quantity: 5, ttlMinutes: 60 },
        NOW,
      ),
    );
    const reservation = out.reservation!;
    // «Сейчас» позже истечения.
    const ok = await withTransaction(state, (s) =>
      confirm(s, reservation, 'FIFO', { nowMs: NOW + 61 * 60_000 }),
    );
    expect(ok).toBe(false);
    // Удержание не тронуто.
    expect(state.batches.find((b) => b.id === 'B1')!.reserved).toBe(5);
  });
});

describe('ReservationService.cancel', () => {
  it('освобождает удержание партий и помечает резерв released', async () => {
    const state = baseState();
    const out = await withTransaction(state, (s) =>
      reserve(s, { productId: 'P1', warehouseId: 'W1', quantity: 15 }, NOW),
    );
    const reservation = out.reservation!;

    const ok = await withTransaction(state, (s) => cancel(s, reservation));
    expect(ok).toBe(true);

    // Удержание возвращено.
    for (const b of state.batches) expect(b.reserved).toBe(0);
    // Остаток товара не тронут (резерв не списывает).
    expect(state.products.find((p) => p.id === 'P1')!.quantity).toBe(30);
    // Статусы released.
    for (const r of state.reservations) expect(r.status).toBe('released');
    // Списаний не было.
    expect(state.writeoffs).toHaveLength(0);
  });

  it('отмена уже неактивного резерва возвращает false', async () => {
    const state = baseState();
    const out = await withTransaction(state, (s) =>
      reserve(s, { productId: 'P1', warehouseId: 'W1', quantity: 5 }, NOW),
    );
    const reservation = out.reservation!;
    await withTransaction(state, (s) => cancel(s, reservation));

    const second = await withTransaction(state, (s) => cancel(s, reservation));
    expect(second).toBe(false);
  });
});

describe('ReservationService.expireOutdated', () => {
  it('снимает истёкшие по TTL резервы и освобождает удержание', async () => {
    const state = baseState();
    await withTransaction(state, (s) =>
      reserve(
        s,
        { productId: 'P1', warehouseId: 'W1', quantity: 15, ttlMinutes: 60 },
        NOW,
      ),
    );
    // Удержание есть.
    expect(state.batches.find((b) => b.id === 'B1')!.reserved).toBe(10);

    // Прогон уборщика ПОСЛЕ истечения TTL.
    const n = await withTransaction(state, (s) =>
      expireOutdated(s, NOW + 61 * 60_000),
    );
    expect(n).toBe(2); // две ноги

    for (const b of state.batches) expect(b.reserved).toBe(0);
    for (const r of state.reservations) expect(r.status).toBe('expired');
  });

  it('активные (не истёкшие) резервы не трогает', async () => {
    const state = baseState();
    await withTransaction(state, (s) =>
      reserve(
        s,
        { productId: 'P1', warehouseId: 'W1', quantity: 5, ttlMinutes: 60 },
        NOW,
      ),
    );
    // «Сейчас» ещё до истечения.
    const n = await withTransaction(state, (s) =>
      expireOutdated(s, NOW + 10 * 60_000),
    );
    expect(n).toBe(0);
    expect(state.batches.find((b) => b.id === 'B1')!.reserved).toBe(5);
    for (const r of state.reservations) expect(r.status).toBe('active');
  });
});
