# @smartstack/writeoff-engine

Партионный (lot/batch) движок списания запасов: **FIFO**, **LIFO**,
**средневзвешенная** (weighted average). Storage-agnostic — хранилище подключаете
своё через интерфейс `BatchStore`. Без БД, без Prisma, без Qt.

> Batch (lot) inventory write-off engine: FIFO, LIFO, weighted average. Bring your
> own storage via the `BatchStore` interface. No database required to run or test.

## Что это (RU)

Каждая поставка (партия) хранит свою себестоимость. Движок подбирает партии для
списания и считает себестоимость списанного:

- **FIFO** — списываем сначала самые старые партии (`received_at ASC`).
- **LIFO** — сначала самые новые (`received_at DESC`).
- **WeightedAverage** — распределяем количество ПРОПОРЦИОНАЛЬНО доступным остаткам
  всех активных партий; себестоимость каждой строки = средневзвешенная цена;
  остаток округления отдаётся последней значимой партии (сумма строк = запрошенному
  количеству).

Доступный остаток партии = `quantity − reserved`, поэтому резервы учитываются точно.
Возвраты/корректировки — обычные движения с соответствующей причиной (`WriteoffReason`).

Инварианты (порт из C++ оригинала, см. `cpp-reference/`):

- Недостаточно остатка → `INSUFFICIENT_STOCK`, **без частичного списания**: вся
  операция откатывается (никаких изменений).
- Точное обнуление партии → её статус становится `exhausted`.
- Сравнения вещественных — с эпсилоном `EPS = 1e-6`.
- Деньги округляются до 2 знаков.

## What it is (EN)

Each delivery (batch/lot) keeps its own cost price. The engine picks batches to
write off and computes the cost of goods removed using FIFO, LIFO, or weighted
average. Available quantity per batch is `quantity − reserved`, so reservations are
honored precisely; returns/corrections are ordinary movements with a reason code.
If stock is insufficient it returns `INSUFFICIENT_STOCK` and makes **no partial
write-off** — the whole operation is rolled back.

## Абстракция хранилища — `BatchStore`

Движок не знает о вашей БД. Он работает через узкий порт `BatchStore` (подбор
активных партий, декремент остатка, запись движения, декремент кэша остатка товара
и т.д.). Реализуйте его поверх своего хранилища (Prisma, SQLite, драйвер Postgres —
что угодно). Все методы вызываются уже **внутри вашей транзакции**.

Для тестов и примеров в комплекте идёт `FakeBatchStore` — in-memory реализация,
которая эмулирует транзакцию с откатом (`withTransaction`). Никакой БД не нужно.

## Установка

```bash
npm install @smartstack/writeoff-engine
```

## Пример использования

```ts
import {
  applyWriteoff,
  makeState,
  withTransaction,
} from '@smartstack/writeoff-engine';

// In-memory состояние (в реальном коде — своя реализация BatchStore поверх БД).
const state = makeState({
  products: [{ id: 'P1', quantity: 20 }],
  batches: [
    { id: 'B1', productId: 'P1', warehouseId: 'W1', quantity: 10, reserved: 0,
      costPrice: 100, receivedAt: 1000, status: 'active' },
    { id: 'B2', productId: 'P1', warehouseId: 'W1', quantity: 10, reserved: 0,
      costPrice: 200, receivedAt: 2000, status: 'active' },
  ],
});

// Списываем 15 шт. по FIFO в рамках транзакции с откатом при ошибке.
const result = await withTransaction(state, (store) =>
  applyWriteoff(store, {
    productId: 'P1',
    warehouseId: 'W1',
    quantity: 15,
    method: 'FIFO',          // 'FIFO' | 'LIFO' | 'WeightedAverage'
    reason: 'sale',
    userId: 'U1',
  }),
);

console.log(result.items);
// [ { batchId: 'B1', quantity: 10, costPrice: 100, ... },
//   { batchId: 'B2', quantity: 5,  costPrice: 200, ... } ]
console.log(result.totalCost); // 2000  (10*100 + 5*200)
```

Только расчёт (без записи) — `computePlan(store, productId, qty, method, warehouseId?)`.
Справочно: `getAvailableQtyVia(...)` и `getWeightedAverageCostVia(...)`.

## Реализация своего `BatchStore`

```ts
import type { BatchStore } from '@smartstack/writeoff-engine';

class MyStore implements BatchStore {
  async findActiveBatches(query, order) { /* SELECT ... ORDER BY ... */ }
  async decrementBatchQuantity(batchId, qty) { /* UPDATE batches ... */ }
  async insertWriteoff(movement) { /* INSERT batch_writeoffs ... */ }
  async decrementProductQuantity(productId, qty) { /* UPDATE products ... */ }
  // ...остальные методы интерфейса
}
```

Запускайте `applyWriteoff(new MyStore(tx), params)` **внутри вашей транзакции**:
при `INSUFFICIENT_STOCK` движок бросает исключение (`err.code === 'INSUFFICIENT_STOCK'`),
ваша транзакция откатится — частичных списаний не будет.

## Скрипты

```bash
npm run build   # tsc -> dist/
npm test        # vitest run
```

## C++ оригинал

В `cpp-reference/` лежит **оригинальный** десктопный движок (`WriteoffEngine.hpp` /
`WriteoffEngine.cpp`), из которого этот пакет портирован. Он завязан на Qt + SQLite
и здесь **не собирается** — это эталон семантики. Запускаемая, развязанная версия —
эта, на TypeScript. Подробности — `cpp-reference/README.md`.

## Лицензия

MIT.
