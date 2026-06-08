# C++ reference — original desktop write-off engine

These two files are the **original** SmartStock desktop write-off engine, copied
here **verbatim** for reference:

- `WriteoffEngine.hpp`
- `WriteoffEngine.cpp`

They are the source of truth for the algorithm semantics (FIFO / LIFO / weighted
average, the `kEps = 1e-6` epsilon, the "no partial write-off" transaction
invariant, the weighted-average rounding remainder going to the last significant
batch). The TypeScript engine in `../src/` is a 1:1 port of this logic.

**This C++ code is NOT built here.** It is tightly coupled to the desktop stack:
Qt (`QObject`, `QString`, `QUuid`, signals/slots), SQLite (`sqlite3`, prepared
statements), and the desktop's own infrastructure (`DatabaseManager`,
`data::Transaction`, `ActionLogger`, `AppSettings`). It depends on headers that
do not ship with this package and cannot compile standalone.

The runnable, decoupled, storage-agnostic implementation is the TypeScript one
(`../src/writeoff.engine.ts`), which works against the `BatchStore` interface and
ships with an in-memory `FakeBatchStore` so the engine and its tests run with no
database at all.
