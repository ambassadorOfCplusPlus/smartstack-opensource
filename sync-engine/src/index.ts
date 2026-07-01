// @smartstack/sync-engine — переиспользуемое ядро offline-first событийной
// синхронизации: vector clocks, идемпотентный журнал, классификация конфликтов.
//
// Чистый рантайм-агностичный код (без Prisma/Fastify). Дизайн целиком — в
// docs/DESIGN.md; исходный связанный код SmartStock — в reference/.

export {
  type VectorClock,
  dominates,
  isConcurrent,
  increment,
  merge,
} from './vector-clock';

export {
  EPS,
  type PhysicalInput,
  type PhysicalOutcome,
  classifyPhysical,
  FieldVerdict,
  type SemanticInput,
  classifySemantic,
  type Choice,
  type ResolutionMode,
  type VoteTally,
  type VoteResolution,
  tallyVote,
  resolveByAdmin,
} from './conflict';

export {
  type OperationStatus,
  type SyncOperation,
  type JournalEntry,
  type AppendResult,
  type OperationJournal,
  InMemoryJournal,
} from './journal';

// ── ТЕКУЩИЙ стек синхронизации оригинала: E2E-реле + дедуп по op_id + ts-курсор.
// Legacy serverSeq/vector-clock/conflict выше — модель ГИБРИДА (ещё жива).
// Ниже — реле-стек ОРИГИНАЛА десктопа (см. docs/DESIGN.md §8).

export {
  type Key,
  type SyncOp,
  generateKey,
  keyToString,
  keyFromString,
  newOpId,
  buildBatchJson,
  parseBatchJson,
  encodeFrame,
  decodeFrame,
  encodeFrameBase64,
  decodeFrameBase64,
  encodeBatchBase64,
  decodeBatchBase64,
} from './relay/codec';

export {
  type RelayConfig,
  type RelayEntry,
  type FetchLike,
  type IRelay,
  type RelayClientOptions,
  relayhttp,
  HttpRelayClient,
} from './relay/relay';

export {
  optype,
  type ApplyStatus,
  type OpResult,
  type ApplyOutcome,
  type ISyncApplier,
  type IDedupStore,
  InMemoryDedupStore,
  applyBatch,
} from './relay/engine';

export {
  type PullResult,
  pushBatch,
  applyOneFrame,
  pullApply,
} from './relay/orchestrator';
