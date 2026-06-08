// Контракт операций синхронизации десктоп → сервер (Фаза 2, S5).
//
// ЭТОТ ФАЙЛ — ЗАФИКСИРОВАННЫЙ КОНТРАКТ. Десктоп (этапы D3/D4) пишет операции
// строго под него. Менять формат — только синхронно с десктопом.
//
// Принципы (см. CLAUDE.md гибрид):
//  - синхронизируем СОБЫТИЯ (операции), не состояние;
//  - id операции генерирует ДЕСКТОП (UUID) — он же ключ идемпотентности;
//  - часам ПК не доверяем: порядок задаёт серверный serverSeq + vectorClock;
//  - списание привязано к КОНКРЕТНОЙ партии по UUID (детерминизм при слиянии),
//    НЕ FIFO-подбор.

// Тип сущности, к которой относится операция.
export type SyncEntityType = 'batch' | 'product';

// Вид операции.
export type SyncOperationKind =
  | 'batch_receipt'
  | 'batch_writeoff'
  | 'product_update';

// Вектор часов: deviceId → счётчик. Используется S7 для детекции конкуррентности.
export type VectorClock = Record<string, number>;

// ─────────────────────────────────────────────────────────────────────────────
// Payload по типам операций
// ─────────────────────────────────────────────────────────────────────────────

// Приход: создаётся НОВАЯ партия. entityId операции = id этой партии (UUID с ПК!).
export interface BatchReceiptPayload {
  productId: string;
  warehouseId: string;
  quantity: number;
  costPrice: number;
  // ISO-строки времени с десктопа (приём/срок годности). Опциональны.
  receivedAt?: string;
  expiryDate?: string;
  // Валюта закупки (ISO 4217) и курс к рублю. costPrice ВСЕГДА в рублях;
  // отсутствие = "RUB"/1.
  costCurrency?: string;
  fxRate?: number;
}

// Списание С КОНКРЕТНОЙ партии по batchId (детерминизм, не FIFO).
export interface BatchWriteoffPayload {
  batchId: string;
  productId: string;
  warehouseId: string;
  quantity: number;
  reason: import('@prisma/client').WriteoffReason;
}

// Поля товара, которые разрешено менять через product_update (whitelist).
export type ProductUpdateField =
  | 'name'
  | 'price'
  | 'minStock'
  | 'barcode'
  | 'unit';

// Обновление одного поля товара. entityId операции = productId.
export interface ProductUpdatePayload {
  field: ProductUpdateField;
  value: unknown;
  // prevValue — для будущей детекции конфликтов (S7), сейчас не используется.
  prevValue?: unknown;
}

export type SyncPayload =
  | BatchReceiptPayload
  | BatchWriteoffPayload
  | ProductUpdatePayload;

// Операция синхронизации (как пишет десктоп).
export interface SyncOperation {
  id: string; // UUID, генерирует десктоп
  entityType: SyncEntityType;
  entityId: string; // UUID партии (receipt/writeoff) или товара (product_update)
  operation: SyncOperationKind;
  payload: SyncPayload;
  vectorClock: VectorClock;
  createdAt: string; // ISO, время операции на ПК
}

// ─────────────────────────────────────────────────────────────────────────────
// Ответ POST /sync/push
// ─────────────────────────────────────────────────────────────────────────────

export type AcceptedStatus = 'accepted' | 'conflict';

// Принятая (или ранее принятая, идемпотентный повтор) операция.
export interface AcceptedEntry {
  id: string;
  serverSeq: string; // BigInt сериализуется в строку
  status: AcceptedStatus;
}

// Конфликт.
//  - physical: нехватка остатка (S5/S7.2) — detail с shortage;
//  - semantic: конкуррентная правка поля (S7.3) — открыто голосование
//    (conflictId), либо поле заморожено уже идущим голосованием (frozen).
export interface ConflictEntry {
  id: string;
  type: 'physical' | 'semantic';
  detail:
    | { shortage: number; requested: number; available: number }
    | { conflictId: string; field?: string; frozen?: boolean };
}

// Отклонённая операция (невалидная / неизвестный тип / нет доступа к складу).
export interface RejectedEntry {
  id: string;
  error: string;
}

export interface PushResult {
  accepted: AcceptedEntry[];
  conflicts: ConflictEntry[];
  rejected: RejectedEntry[];
  maxServerSeq: string; // максимальный serverSeq среди записанных операций
}

// ─────────────────────────────────────────────────────────────────────────────
// Ответ GET /sync/pull (S6.1) — чужие операции для применения на десктопе
// ─────────────────────────────────────────────────────────────────────────────

// Операция в выдаче pull: как SyncOperation + серверные поля.
export interface PulledOperation {
  id: string;
  deviceId: string; // устройство-источник (НЕ запрашивающее)
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperationKind;
  payload: SyncPayload;
  vectorClock: VectorClock;
  serverSeq: string; // BigInt → строка
  createdAt: string; // ISO
}

export interface PullResult {
  operations: PulledOperation[];
  // serverSeq последней отданной операции (для следующего ?since=).
  maxServerSeq: string;
  // Остались ли ещё операции за пределами лимита страницы.
  hasMore: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ответ GET /sync/snapshot (S6.2) — полный снимок для первой синхронизации ПК
// ─────────────────────────────────────────────────────────────────────────────

export interface SnapshotProduct {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  unit: string;
  price: number;
  minStock: number;
  quantity: number;
}

export interface SnapshotBatch {
  id: string;
  productId: string;
  warehouseId: string;
  quantity: number;
  reserved: number;
  costPrice: number; // всегда в рублях
  costCurrency: string; // валюта закупки (ISO 4217), дефолт RUB
  fxRate: number; // курс к рублю на момент прихода, дефолт 1
  receivedAt: string; // ISO
  expiryDate: string | null;
  status: string;
}

// Ячейка склада в снапшоте (мультисклад: десктоп раскладывает по складам).
export interface SnapshotCell {
  id: string;
  warehouseId: string;
  code: string;
  name: string | null;
}

export interface SnapshotResult {
  warehouseId: string;
  products: SnapshotProduct[];
  batches: SnapshotBatch[];
  // Ячейки склада (для вкладки «Склад» десктопа по выбранному складу).
  cells: SnapshotCell[];
  // Текущий максимальный serverSeq организации: десктоп начинает pull с него.
  lastSeq: string;
}
