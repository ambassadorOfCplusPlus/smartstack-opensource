// In-memory фейк BatchStore для тестов и примеров БЕЗ БД.
//
// Эмулирует $transaction с откатом (rollback): перед выполнением делается
// глубокая копия состояния; при исключении состояние восстанавливается — так
// воспроизводится инвариант «нет частичного списания» из WriteoffEngine.cpp.

import {
  EPS,
  type BatchStore,
  type BatchQuery,
  type BatchRow,
  type ReservationRow,
  type WriteoffMovement,
} from './types';

export interface FakeBatch {
  id: string;
  productId: string;
  warehouseId: string;
  quantity: number;
  reserved: number;
  costPrice: number;
  // Валюта/курс закупки (опционально в фикстурах; дефолт RUB/1).
  costCurrency?: string;
  fxRate?: number;
  receivedAt: number; // epoch ms
  status: 'active' | 'exhausted' | 'expired';
}

export interface FakeWriteoff {
  id: string;
  batchId: string;
  quantity: number;
  costPrice: number;
  reason: string;
  documentId: string | null;
  userId: string;
}

export interface FakeProduct {
  id: string;
  quantity: number;
}

export interface FakeState {
  batches: FakeBatch[];
  writeoffs: FakeWriteoff[];
  reservations: ReservationRow[];
  products: FakeProduct[];
  seq: number;
}

export function makeState(init: Partial<FakeState>): FakeState {
  return {
    batches: init.batches ?? [],
    writeoffs: init.writeoffs ?? [],
    reservations: init.reservations ?? [],
    products: init.products ?? [],
    seq: init.seq ?? 0,
  };
}

function clone(s: FakeState): FakeState {
  return {
    batches: s.batches.map((b) => ({ ...b })),
    writeoffs: s.writeoffs.map((w) => ({ ...w })),
    reservations: s.reservations.map((r) => ({ ...r })),
    products: s.products.map((p) => ({ ...p })),
    seq: s.seq,
  };
}

// Фейковый store поверх изменяемого FakeState.
export class FakeBatchStore implements BatchStore {
  constructor(public state: FakeState) {}

  private nextId(prefix: string): string {
    this.state.seq += 1;
    return `${prefix}-${this.state.seq}`;
  }

  async findActiveBatches(
    query: BatchQuery,
    order: 'received_asc' | 'received_desc' | 'none',
  ): Promise<BatchRow[]> {
    let rows = this.state.batches.filter(
      (b) =>
        b.productId === query.productId &&
        b.status === 'active' &&
        b.quantity - b.reserved > EPS &&
        (query.warehouseId === undefined || b.warehouseId === query.warehouseId),
    );
    if (order === 'received_asc') {
      // Тай-брейк по id — codepoint-сравнение (как ORDER BY id в SQLite/Postgres),
      // НЕ локалезависимый localeCompare: иначе при одинаковом receivedAt (массовый
      // импорт) JS-store выбрал бы другую партию, чем реальная БД → другая cost_price.
      rows = rows.sort((a, b) => a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } else if (order === 'received_desc') {
      rows = rows.sort((a, b) => b.receivedAt - a.receivedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    }
    return rows.map((b) => ({
      id: b.id,
      productId: b.productId,
      warehouseId: b.warehouseId,
      quantity: b.quantity,
      reserved: b.reserved,
      costPrice: b.costPrice,
      costCurrency: b.costCurrency ?? 'RUB',
      fxRate: b.fxRate ?? 1,
      receivedAt: b.receivedAt,
      status: b.status,
    }));
  }

  async decrementBatchQuantity(batchId: string, qty: number): Promise<void> {
    const b = this.state.batches.find((x) => x.id === batchId);
    if (!b) throw new Error(`batch ${batchId} not found`);
    b.quantity -= qty;
    if (b.quantity <= EPS) b.status = 'exhausted';
  }

  async adjustBatchReserved(batchId: string, delta: number): Promise<void> {
    const b = this.state.batches.find((x) => x.id === batchId);
    if (!b) throw new Error(`batch ${batchId} not found`);
    b.reserved = Math.max(0, b.reserved + delta);
  }

  async insertWriteoff(m: WriteoffMovement): Promise<void> {
    this.state.writeoffs.push({
      id: this.nextId('wo'),
      batchId: m.batchId,
      quantity: m.quantity,
      costPrice: m.costPrice,
      reason: m.reason,
      documentId: m.documentId ?? null,
      userId: m.userId,
    });
  }

  async decrementProductQuantity(productId: string, qty: number): Promise<void> {
    const p = this.state.products.find((x) => x.id === productId);
    if (!p) throw new Error(`product ${productId} not found`);
    p.quantity -= qty;
  }

  async incrementProductQuantity(productId: string, qty: number): Promise<void> {
    const p = this.state.products.find((x) => x.id === productId);
    if (!p) throw new Error(`product ${productId} not found`);
    p.quantity += qty;
  }

  async insertReservation(row: Omit<ReservationRow, 'id'>): Promise<string> {
    const id = this.nextId('res');
    this.state.reservations.push({ ...row, id });
    return id;
  }

  async getReservation(reservationId: string): Promise<ReservationRow | null> {
    const r = this.state.reservations.find((x) => x.id === reservationId);
    return r ? { ...r } : null;
  }

  async updateReservationStatus(
    reservationId: string,
    status: ReservationRow['status'],
  ): Promise<void> {
    const r = this.state.reservations.find((x) => x.id === reservationId);
    if (!r) throw new Error(`reservation ${reservationId} not found`);
    r.status = status;
  }

  async findExpiredReservations(nowMs: number): Promise<ReservationRow[]> {
    return this.state.reservations
      .filter((r) => r.status === 'active' && r.expiresAt != null && r.expiresAt < nowMs)
      .map((r) => ({ ...r }));
  }
}

// Эмуляция $transaction: снимок состояния, откат при throw.
export async function withTransaction<T>(
  state: FakeState,
  fn: (store: FakeBatchStore) => Promise<T>,
): Promise<T> {
  const snapshot = clone(state);
  const store = new FakeBatchStore(state);
  try {
    return await fn(store);
  } catch (e) {
    // Откат: восстанавливаем поля исходного объекта state (in-place).
    state.batches = snapshot.batches;
    state.writeoffs = snapshot.writeoffs;
    state.reservations = snapshot.reservations;
    state.products = snapshot.products;
    state.seq = snapshot.seq;
    throw e;
  }
}
