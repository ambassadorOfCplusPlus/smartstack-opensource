# @smartstack/marketplace-adapters

A dependency-light TypeScript library of **FBS adapters** for the four major Russian
marketplaces — **Wildberries**, **Ozon**, **Yandex.Market** and **Sber Megamarket**.
Each adapter speaks the platform's seller HTTP API and exposes one unified interface:
push stocks, push prices, import new orders.

Key design points:

- **The HTTP client is injected** via a tiny `FetchLike` abstraction. The library has
  **no hard runtime dependency** (no axios, no node-fetch) and **no telemetry**. Pass
  the global `fetch`, an instrumented client, or a fake for tests.
- **Seller API keys are passed in by the caller and are NEVER stored** anywhere by the
  library — they live only inside the `AdapterAccount` you hand to the adapter.
- **Built-in retry** on transient errors (HTTP 429 and 5xx, up to 3 attempts with a
  small injectable backoff). 4xx (except 429) is not retried.
- **Strict TypeScript**, fully unit-tested without touching the network.

---

## Русское описание

Библиотека FBS-адаптеров маркетплейсов **Wildberries / Ozon / Яндекс.Маркет /
СберМегаМаркет**. Единый интерфейс: выгрузка остатков, выгрузка цен, импорт новых
заказов.

- HTTP-клиент **инжектируется** через абстракцию `FetchLike` — у библиотеки нет
  жёстких зависимостей и телеметрии, её удобно тестировать фейк-fetch'ем.
- Ключи продавца передаёт вызывающий код, библиотека их **нигде не хранит**.
- Встроенный ретрай на 429/5xx (до 3 попыток, бэкофф инжектируется).

---

## Установка

```bash
npm install @smartstack/marketplace-adapters
```

## Быстрый старт

```ts
import { adapterFor } from '@smartstack/marketplace-adapters';

// fetch инжектируется. По умолчанию фабрика берёт глобальный fetch (Node 18+),
// но можно передать свой (с логированием, прокси, ретраями и т.п.).
const ozon = adapterFor({
  platform: 'ozon',
  apiKey: process.env.OZON_API_KEY!, // ключ передаёт вызывающий код, не хранится в либе
  clientId: process.env.OZON_CLIENT_ID!,
  externalWarehouseId: '12345',
});

// Выгрузить остатки на МП.
const stockResult = await ozon.pushStocks([
  { externalId: 'OF1', sku: 'OF1', qty: 7 },
]);
console.log(stockResult); // { ok: 1, errors: [] }

// Импортировать новые (необработанные) заказы.
const orders = await ozon.fetchNewOrders();

// Выгрузить цены (если площадка поддерживает).
await ozon.pushPrices?.([{ externalId: 'OF1', sku: 'OF1', price: 1990 }]);
```

### Инъекция собственного fetch

```ts
import { WbAdapter, type FetchLike } from '@smartstack/marketplace-adapters';

const myFetch: FetchLike = async (url, init) => {
  // например, логирование/прокси/метрики
  return fetch(url, init);
};

const wb = new WbAdapter(
  { platform: 'wb', apiKey: WB_TOKEN, externalWarehouseId: '777' },
  { fetchImpl: myFetch },
);
```

---

## Единый интерфейс адаптера

```ts
interface MarketplaceAdapter {
  readonly platform: 'wb' | 'ozon' | 'yandex' | 'sber';
  pushStocks(items: StockItem[]): Promise<PushResult>;          // остатки → МП
  fetchNewOrders(since?: Date): Promise<RawOrder[]>;            // заказы МП → нам
  pushPrices?(items: PriceItem[]): Promise<PushResult>;        // цены (опционально)
  updateOrderStatus?(externalOrderId: string, status: string): Promise<void>;
}
```

`PushResult` — это `{ ok: number; errors: string[] }`: сколько позиций принято и
тексты ошибок по непринятым. Адаптеры остатков/цен **не бросают** на сетевых/HTTP
ошибках — складывают их в `errors`. `fetchNewOrders` бросает при сетевой/HTTP ошибке.

`AdapterAccount` (что передаёте в адаптер):

| Поле | Назначение |
|---|---|
| `platform` | `'wb' \| 'ozon' \| 'yandex' \| 'sber'` |
| `apiKey` | токен продавца (для Сбера уходит в тело запроса, не в заголовок) |
| `clientId` | Ozon — `Client-Id`; Яндекс.Маркет — `campaignId` магазина |
| `externalWarehouseId` | id склада на стороне МП (WB обязателен для остатков) |

---

## Что поддерживает каждый адаптер

| Площадка | pushStocks | pushPrices | fetchNewOrders | Особенности |
|---|---|---|---|---|
| **Wildberries** (`wb`) | `PUT /api/v3/stocks/{warehouseId}` | `POST /api/v2/upload/task` (отдельный хост `discounts-prices-api`) | `GET /api/v3/orders/new` | Для остатков обязателен `externalWarehouseId`. **pushPrices требует, чтобы `externalId` listing'а был числовым `nmID` (целое > 0)** — нечисловой `externalId` отбрасывается в `errors`, остальные позиции отправляются. FBS-заказ — одна позиция (берётся из `skus[0]`/`article`/`nmId`); цена приходит в копейках. |
| **Ozon** (`ozon`) | `POST /v2/products/stocks` | `POST /v1/product/import/prices` | `POST /v3/posting/fbs/unfulfilled/list` (пагинация) | Заголовки `Client-Id` + `Api-Key`. Импорт заказов пагинируется (страница 100, максимум 20 страниц = 2000 заказов, при превышении — предупреждение в `console.warn`). Разбирает `result[].updated/errors` для точного подсчёта `ok`. |
| **Яндекс.Маркет** (`yandex`) | `PUT /campaigns/{campaignId}/offers/stocks` | `POST /campaigns/{campaignId}/offer-prices/updates` | `GET /campaigns/{campaignId}/orders?status=PROCESSING` (пагинация) | `clientId` = `campaignId` магазина, **обязателен** для всех вызовов. Заголовок `Api-Key`. Цены в `RUR`. Логический статус ответа `{status:"ERROR"}` маппится в `errors`. Эндпоинты по документации Partner API — перед боем сверить с кабинетом. |
| **СберМегаМаркет** (`sber`) | `POST .../offerService/stock/update` | `POST .../offerService/manualPrice/save` | `POST /api/market/v1/orderService/order/new` | **Токен передаётся В ТЕЛЕ** (`data.token`), не в заголовке. Все вызовы — POST с конвертом `{meta:{}, data:{token, ...}}`. HTTP обычно 200 даже при логической ошибке — успех определяется полем `success === 1`. Эндпоинты по Merchant API — перед боем сверить с кабинетом. |

---

## Разработка

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc → dist/
```

## Лицензия

MIT.
