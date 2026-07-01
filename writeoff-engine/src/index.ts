// Публичный API пакета @smartstack/writeoff-engine.

export {
  applyWriteoff,
  computePlan,
  getAvailableQtyVia,
  getWeightedAverageCostVia,
  round2,
  type WriteoffParams,
} from './writeoff.engine';

export {
  EPS,
  type BatchStore,
  type BatchQuery,
  type BatchRow,
  type WriteoffMethod,
  type WriteoffReason,
  type WriteoffResult,
  type WriteoffLineResult,
  type WriteoffMovement,
  type ReserveRequest,
  type ReservationResult,
  type ReservationRow,
} from './types';

export {
  reserve,
  confirm,
  cancel,
  expireOutdated,
  DEFAULT_TTL_MINUTES,
  type Reservation,
  type ReservationLeg,
  type ReserveOutcome,
} from './reservation.service';

export {
  FakeBatchStore,
  makeState,
  withTransaction,
  type FakeBatch,
  type FakeWriteoff,
  type FakeProduct,
  type FakeState,
} from './fake-store';
