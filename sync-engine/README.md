# @smartstack/sync-engine

Ядро **offline-first** событийной синхронизации: vector clocks, идемпотентный
журнал операций, классификация конфликтов (физический vs смысловой). Извлечено
из [SmartStock](https://smartstock) — гибридной системы «рой десктопов + узел
синхронизации». MIT.

Пакет состоит из трёх частей:

- **`src/`** — чистое, рантайм-агностичное, запускаемое ядро (БЕЗ Prisma/Fastify,
  без рантайм-зависимостей). Это то, что можно переиспользовать.
- **`docs/DESIGN.md`** — подробный справочный дизайн всей архитектуры
  (события вместо состояния, идемпотентность по UUID, vector clocks,
  **gap-free pull через xmin-горизонт**, два типа конфликтов).
- **`reference/`** — оригинальный серверный код SmartStock, вербатим, связанный с
  Prisma/Fastify. Не собирается; лежит для изучения вместе с дизайном.

## Что внутри ядра (`src/`)

- `vector-clock.ts` — `VectorClock` + `dominates`/`isConcurrent` (вербатим из
  боевого кода) + хелперы `increment`/`merge`.
- `conflict.ts` — `classifyPhysical` (недостача без голосования),
  `classifySemantic` (конкуррентная правка → голосование), `tallyVote`,
  `resolveByAdmin`.
- `journal.ts` — `InMemoryJournal`: идемпотентность по UUID + монотонный
  `serverSeq` + курсор `pull`. Storage-agnostic интерфейс `OperationJournal`.

## Запуск

```bash
npm i
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest (40 тестов)
npm run build       # → dist/
```

## Идея в двух строках

Синхронизируем **операции** (приход +100, списание −30), а не состояние. Каждая
операция = UUID (генерирует устройство, он же ключ идемпотентности) + `deviceId`
+ `vectorClock`. Сервер применяет по порядку, считает итог. Конфликты бывают
**физические** (остаток в минус → фиксируем недостачу, голосование не нужно) и
**смысловые** (параллельная правка поля → заморозка + голосование, большинство
или вето админа). Полный разбор — в [`docs/DESIGN.md`](docs/DESIGN.md).

---

## English (short)

`@smartstack/sync-engine` is the reusable core of an **offline-first, event-based
sync** design, extracted from SmartStock (MIT). We sync **events** (receipt +100,
writeoff −30), not state. Each op carries a device-generated UUID (the idempotency
key), a `deviceId`, and a `vectorClock`; the server applies in order and computes
totals.

- **`src/`** — pure, runnable core: vector clocks (`dominates`/`isConcurrent` +
  `increment`/`merge`), an idempotent in-memory journal (UUID dedupe + monotonic
  `serverSeq`), and conflict classification — **physical** (negative stock → record
  a shortage, no vote) vs **semantic** (concurrent field edit → freeze + vote,
  majority or admin veto). No runtime deps.
- **`docs/DESIGN.md`** — the full reference design, including the subtle
  **gap-free pull via the Postgres xmin horizon** (why a naive `serverSeq > since`
  cursor can permanently skip a committed op, and how the visibility horizon fixes
  it).
- **`reference/`** — the original SmartStock server code (coupled to
  Prisma/Fastify), verbatim, for study; not built.

```bash
npm i && npm run typecheck && npm test
```
