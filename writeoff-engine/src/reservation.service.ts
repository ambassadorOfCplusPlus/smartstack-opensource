// Резервы под заказ (порт ReservationService из десктопа,
// src/inventory/ReservationService.cpp). Storage-agnostic: работает не с БД, а
// через тот же порт BatchStore, что и WriteoffEngine.
//
// Семантика 1:1 с C++ оригиналом:
//  - reserve: FIFO-распределение резерва по активным партиям (батч.reserved += доля,
//    ORDER BY received_at ASC, id ASC), проверка доступного остатка ДО любых записей
//    → нехватка = отказ БЕЗ частичного резерва (никаких изменений);
//  - confirm: атомарно снимает удержание, проводит списание зарезервированного через
//    ТОТ ЖЕ движок applyWriteoff (не дублируя FIFO) и переводит резерв в 'confirmed'.
//    Сначала release удержания — чтобы план списания «увидел» этот остаток доступным
//    (как в ReservationService.cpp: releaseOnBatches → writeoffInTransaction);
//  - cancel: возвращает удержание партиям (батч.reserved -= доля), статус 'released';
//  - expireOutdated: снимает истёкшие по TTL резервы (status='active' И expires_at < now),
//    освобождает их удержание.
//
// Транзакционность обеспечивает вызывающий код: функции выполняются уже ВНУТРИ
// открытой транзакции переданного store (как applyWriteoff). При ошибке бросается
// исключение — внешняя транзакция откатывается без частичных изменений.
//
// МОДЕЛЬ ХРАНЕНИЯ. В C++ reservations — одна строка на резерв, а разбивка по партиям
// живёт в агрегате batches.reserved. Порт BatchStore хранит резерв как строку с
// единственным batchId (ReservationRow.batchId), а все операции стора — по одному id.
// Поэтому один логический резерв, покрывающий НЕСКОЛЬКО партий, раскладывается на
// несколько строк-«ног» (leg), по одной на партию. reserve возвращает дескриптор
// Reservation со списком ног; confirm/cancel принимают этот дескриптор (перечитывая
// ноги из стора для защиты от повторного confirm/cancel). expireOutdated работает
// напрямую по строкам стора — группировка не нужна (ноги одного резерва делят
// expires_at и истекают вместе).

import {
  EPS,
  type BatchStore,
  type ReserveRequest,
  type ReservationResult,
  type ReservationRow,
  type WriteoffMethod,
} from './types';
import { applyWriteoff, getAvailableQtyVia } from './writeoff.engine';

// TTL по умолчанию (как QSettings reservations/ttl_minutes = 60 в C++).
export const DEFAULT_TTL_MINUTES = 60;

// Одна «нога» резерва — удержание конкретной доли на конкретной партии.
export interface ReservationLeg {
  reservationId: string; // id строки reservations в сторе
  batchId: string;
  quantity: number;
}

// Дескриптор логического резерва (возвращается reserve, принимается confirm/cancel).
export interface Reservation {
  id: string; // = id первой ноги (для ссылки/логов); ноги в legs
  legs: ReservationLeg[];
  productId: string;
  warehouseId: string;
  quantity: number;
  documentId: string | null;
  orderId: string | null;
  expiresAt: number; // Unix epoch (ms)
}

// Результат reserve = ReservationResult + дескриптор при успехе.
export interface ReserveOutcome extends ReservationResult {
  reservation?: Reservation;
}

// Пустой warehouseId ('') трактуем как «без фильтра по складу» (как id склада 0 в C++).
function whFilter(warehouseId: string): string | undefined {
  return warehouseId ? warehouseId : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// reserve — FIFO-распределение резерва по партиям.
// Выполнять ВНУТРИ транзакции. Нехватка остатка → отказ без частичного резерва.
// ─────────────────────────────────────────────────────────────────────────────
export async function reserve(
  store: BatchStore,
  req: ReserveRequest,
  nowMs: number = Date.now(),
): Promise<ReserveOutcome> {
  const wh = whFilter(req.warehouseId);

  // Доступное для резерва = доступный остаток (SUM(quantity - reserved)), т.к.
  // активные резервы уже отражены в batches.reserved (как availableForReserve в C++).
  const available = await getAvailableQtyVia(store, req.productId, wh);
  if (available + EPS < req.quantity) {
    // Ни одной записи ещё не сделано — частичного резерва нет.
    return { success: false, availableQty: available, error: 'INSUFFICIENT_STOCK' };
  }

  const ttl =
    req.ttlMinutes && req.ttlMinutes > 0 ? req.ttlMinutes : DEFAULT_TTL_MINUTES;
  const expiresAt = nowMs + ttl * 60_000;

  // FIFO: старые партии первыми (received_at ASC, id ASC).
  const batches = await store.findActiveBatches(
    { productId: req.productId, warehouseId: wh },
    'received_asc',
  );

  let remaining = req.quantity;
  const legs: ReservationLeg[] = [];
  for (const b of batches) {
    if (remaining <= EPS) break;
    const headroom = b.quantity - b.reserved;
    const take = Math.min(remaining, headroom);
    if (take <= EPS) continue;
    // Наращиваем удержание партии и фиксируем ногу резерва.
    await store.adjustBatchReserved(b.id, take);
    const legId = await store.insertReservation({
      batchId: b.id,
      productId: req.productId,
      warehouseId: req.warehouseId,
      quantity: take,
      documentId: req.documentId ?? null,
      orderId: req.orderId ?? null,
      status: 'active',
      expiresAt,
    });
    legs.push({ reservationId: legId, batchId: b.id, quantity: take });
    remaining -= take;
  }

  if (remaining > EPS) {
    // После проверки доступности не должно случаться; throw откатит транзакцию.
    throw new Error('не удалось распределить резерв по партиям');
  }

  const reservation: Reservation = {
    id: legs[0]?.reservationId ?? '',
    legs,
    productId: req.productId,
    warehouseId: req.warehouseId,
    quantity: req.quantity,
    documentId: req.documentId ?? null,
    orderId: req.orderId ?? null,
    expiresAt,
  };
  return {
    success: true,
    reservationId: reservation.id,
    availableQty: available - req.quantity,
    reservation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// confirm — провести списание зарезервированного (атомарно).
// Выполнять ВНУТРИ транзакции: снятие удержания + списание + смена статуса — одно целое.
// Возвращает false, если резерв уже не активен или истёк (как в C++). Нехватка на
// списании (патология — удержание же было) пробрасывается исключением → откат.
// ─────────────────────────────────────────────────────────────────────────────
export async function confirm(
  store: BatchStore,
  reservation: Reservation,
  method: WriteoffMethod = 'FIFO',
  opts: { userId?: string; nowMs?: number } = {},
): Promise<boolean> {
  const now = opts.nowMs ?? Date.now();
  const userId = opts.userId ?? 'local';

  // Перечитываем каждую ногу: защита от повторного confirm и от истёкшего резерва.
  for (const leg of reservation.legs) {
    const row = await store.getReservation(leg.reservationId);
    if (!row) return false; // нет записи
    if (row.status !== 'active') return false; // в т.ч. повторный confirm/отменённый
    if (row.expiresAt != null && row.expiresAt <= now) return false; // истёк
  }
  if (reservation.legs.length === 0) return false;

  // Снимаем удержание, чтобы план списания увидел этот остаток доступным.
  for (const leg of reservation.legs) {
    await store.adjustBatchReserved(leg.batchId, -leg.quantity);
  }

  // Списываем зарезервированное количество ТЕМ ЖЕ движком (FIFO/LIFO/средняя).
  // applyWriteoff при нехватке бросает INSUFFICIENT_STOCK → внешняя транзакция откатится.
  await applyWriteoff(store, {
    productId: reservation.productId,
    warehouseId: whFilter(reservation.warehouseId),
    quantity: reservation.quantity,
    method,
    reason: 'sale',
    documentId: reservation.documentId ?? null,
    userId,
  });

  for (const leg of reservation.legs) {
    await store.updateReservationStatus(leg.reservationId, 'confirmed');
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// cancel — отменить активный резерв, вернув удержание партиям.
// Выполнять ВНУТРИ транзакции.
// ─────────────────────────────────────────────────────────────────────────────
export async function cancel(
  store: BatchStore,
  reservation: Reservation,
): Promise<boolean> {
  // Отменять можно только активный резерв (все ноги активны).
  for (const leg of reservation.legs) {
    const row = await store.getReservation(leg.reservationId);
    if (!row) return false;
    if (row.status !== 'active') return false;
  }

  for (const leg of reservation.legs) {
    await store.updateReservationStatus(leg.reservationId, 'released');
    await store.adjustBatchReserved(leg.batchId, -leg.quantity);
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// expireOutdated — снять истёкшие по TTL резервы, освободив их удержание.
// Выполнять ВНУТРИ транзакции. Возвращает число снятых строк.
// ─────────────────────────────────────────────────────────────────────────────
export async function expireOutdated(
  store: BatchStore,
  nowMs: number = Date.now(),
): Promise<number> {
  const rows: ReservationRow[] = await store.findExpiredReservations(nowMs);
  for (const row of rows) {
    await store.updateReservationStatus(row.id, 'expired');
    await store.adjustBatchReserved(row.batchId, -row.quantity);
  }
  return rows.length;
}
