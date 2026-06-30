// @smartstack/marketplace-adapters — публичный API библиотеки.
//
// FBS-адаптеры маркетплейсов (Wildberries / Ozon / Яндекс.Маркет / СберМегаМаркет):
// выгрузка остатков и цен, импорт новых заказов. HTTP-клиент инжектируется через
// FetchLike — у библиотеки нет жёстких сетевых зависимостей и телеметрии, ключи
// продавца передаёт вызывающий код и нигде не сохраняются.

export { adapterFor } from './factory';

export { WbAdapter, createWbAdapter } from './wb.adapter';
export type { WbAdapterOptions } from './wb.adapter';

export { OzonAdapter, createOzonAdapter } from './ozon.adapter';
export type { OzonAdapterOptions } from './ozon.adapter';

export { YandexAdapter, createYandexAdapter } from './yandex.adapter';
export type { YandexAdapterOptions } from './yandex.adapter';

export { SberAdapter, createSberAdapter } from './sber.adapter';
export type { SberAdapterOptions } from './sber.adapter';

export { fetchWithRetry, safeText, errMsg } from './http';
export type { RetryOptions } from './http';

// Импорт финансов маркетплейса — чистые парсеры/построители финотчёта WB/Ozon.
export {
  parseWbFinanceReport,
  parseOzonFinanceTxns,
  parseWbFinanceTable,
  parseOzonFinanceTable,
  buildOzonFinanceRequest,
  parseDateToEpochUtc,
  daysFromCivil,
} from './finance';
export type { FinanceLine, FinanceCategory } from './finance';

export type {
  MarketplacePlatform,
  MarketplaceAdapter,
  AdapterAccount,
  FetchLike,
  StockItem,
  PriceItem,
  RawOrder,
  RawOrderItem,
  PushResult,
} from './types';
