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
