// Типы и порт хранилища для движков партионного учёта.
//
// Архитектура port/adapter: движки (WriteoffEngine) работают не напрямую с
// какой-либо БД, а через узкий интерфейс BatchStore. Это позволяет тестировать
// алгоритмы FIFO/LIFO/WeightedAverage БЕЗ живой БД — в тестах подставляется
// in-memory фейк (FakeBatchStore), эмулирующий $transaction с откатом (rollback)
// при исключении.
//
// Денежные/количественные значения — number (как double в C++ оригинале с eps).
// Любой реальный адаптер хранилища конвертирует свой денежный тип (Decimal и т.п.)
// в number на границе чтения и обратно при записи (округление до 2 знаков).

// Причина списания (соответствует значениям WriteoffReason в исходной схеме).
// Здесь это простой строковый союз — никакой зависимости от Prisma/БД.
export type WriteoffReason =
  | 'sale'
  | 'return'
  | 'writeoff'
  | 'expiry'
  | 'damage'
  | 'inventory'
  | 'inventory_correction'
  | 'transfer';

// Метод списания партий (как enum WriteoffMethod в WriteoffEngine.hpp).
export type WriteoffMethod = 'FIFO' | 'LIFO' | 'WeightedAverage';

// Эпсилон сравнения вещественных, как kEps = 1e-6 в WriteoffEngine.cpp.
export const EPS = 1e-6;

// ─────────────────────────────────────────────────────────────────────────────
// Доменные представления строк (то, что нужно движкам из таблицы batches)
// ─────────────────────────────────────────────────────────────────────────────

// Партия в том объёме, который требуется для подбора (как struct Row в C++).
export interface BatchRow {
  id: string;
  productId: string;
  warehouseId: string;
  quantity: number;
  reserved: number;
  costPrice: number;
  // Валюта закупки и курс к рублю на момент прихода (для сохранения исходной
  // валюты при перемещении партии между складами). costPrice хранится в рублях.
  costCurrency: string;
  fxRate: number;
  receivedAt: number; // Unix epoch (ms) — для сортировки FIFO/LIFO
  status: 'active' | 'exhausted' | 'expired';
}

// Запрос подбора активных партий.
export interface BatchQuery {
  productId: string;
  // undefined = без фильтра по складу (как warehouseId == 0 в C++).
  warehouseId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Результаты списания (порт WriteoffResult / WriteoffLine из WriteoffEngine.hpp)
// ─────────────────────────────────────────────────────────────────────────────

export interface WriteoffLineResult {
  batchId: string;
  quantity: number;
  costPrice: number;
  // Валюта/курс закупки партии-источника (для переноса при перемещении).
  costCurrency: string;
  fxRate: number;
}

export interface WriteoffResult {
  success: boolean;
  totalCost: number;
  averageCost: number;
  items: WriteoffLineResult[];
  // Код ошибки: 'INSUFFICIENT_STOCK' | 'DB_ERROR' (как errorCode в C++).
  error?: string;
  errorMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Резервирование
// ─────────────────────────────────────────────────────────────────────────────

export interface ReserveRequest {
  productId: string;
  quantity: number;
  warehouseId: string;
  documentId?: string | null;
  orderId?: string | null;
  // TTL в минутах. undefined/0 — взять дефолт (60 минут).
  ttlMinutes?: number;
}

export interface ReservationResult {
  success: boolean;
  reservationId?: string;
  availableQty: number;
  error?: string; // 'INSUFFICIENT_STOCK' | 'DB_ERROR'
}

// Параметры записи движения batch_writeoffs.
export interface WriteoffMovement {
  batchId: string;
  quantity: number;
  costPrice: number;
  reason: WriteoffReason;
  documentId?: string | null;
  userId: string;
}

// Запись reservations.
export interface ReservationRow {
  id: string;
  batchId: string;
  productId: string;
  warehouseId: string;
  quantity: number;
  documentId?: string | null;
  orderId?: string | null;
  status: 'active' | 'confirmed' | 'released' | 'expired';
  expiresAt: number | null; // Unix epoch (ms)
}

// ─────────────────────────────────────────────────────────────────────────────
// BatchStore — порт доступа к данным.
//
// Узкое подмножество операций над batches / batch_writeoffs / reservations /
// products, нужное движкам. «Принеси своё хранилище»: реализуй этот интерфейс
// поверх своей БД (Prisma, SQLite, Postgres-драйвер, что угодно). Готовая
// in-memory реализация для тестов/примеров — FakeBatchStore (fake-store.ts).
//
// Все методы выполняются ВНУТРИ уже открытой транзакции (tx передаётся в движок).
// ─────────────────────────────────────────────────────────────────────────────
export interface BatchStore {
  // Активные партии с доступным остатком (quantity - reserved > eps), отсортированные.
  //   order='received_asc'  — FIFO (received_at ASC, id ASC)
  //   order='received_desc' — LIFO (received_at DESC, id DESC)
  //   order='none'          — без сортировки (WeightedAverage)
  findActiveBatches(
    query: BatchQuery,
    order: 'received_asc' | 'received_desc' | 'none',
  ): Promise<BatchRow[]>;

  // Уменьшить остаток партии на qty; при обнулении (<= eps) выставить status='exhausted'.
  decrementBatchQuantity(batchId: string, qty: number): Promise<void>;

  // Изменить reserved партии на delta (может быть отрицательной); не уходить ниже 0.
  adjustBatchReserved(batchId: string, delta: number): Promise<void>;

  // Записать движение списания в batch_writeoffs.
  insertWriteoff(movement: WriteoffMovement): Promise<void>;

  // Декремент денормализованного кэша products.quantity на qty.
  decrementProductQuantity(productId: string, qty: number): Promise<void>;

  // Инкремент products.quantity на qty (приход).
  incrementProductQuantity(productId: string, qty: number): Promise<void>;

  // Создать запись reservations (status active), вернуть id.
  insertReservation(row: Omit<ReservationRow, 'id'>): Promise<string>;

  // Прочитать резерв по id (или null).
  getReservation(reservationId: string): Promise<ReservationRow | null>;

  // Сменить статус резерва.
  updateReservationStatus(
    reservationId: string,
    status: ReservationRow['status'],
  ): Promise<void>;

  // Все активные резервы, у которых expires_at < now.
  findExpiredReservations(nowMs: number): Promise<ReservationRow[]>;
}
