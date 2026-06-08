// Контракт адаптера маркетплейса (Фаза 2). Каждая площадка (WB/Ozon/Яндекс.Маркет/
// СберМегаМаркет) реализует MarketplaceAdapter поверх своего HTTP API. Сетевой fetch
// инжектируется, чтобы тесты не ходили в реальную сеть (фейк-fetch).

// Идентификатор площадки. Один источник правды для типов адаптера/аккаунта;
// синхронен с Zod platformSchema и Prisma-enum MarketplacePlatform.
export type MarketplacePlatform = 'wb' | 'ozon' | 'yandex' | 'sber';

// Позиция для выгрузки остатков на МП.
export interface StockItem {
  // Идентификатор карточки на МП (WB nmId / Ozon offer_id) — для соотнесения.
  externalId: string;
  // SKU/баркод, которым площадка идентифицирует остаток (WB sku, Ozon offer_id).
  sku: string;
  barcode?: string | null;
  qty: number;
}

// Позиция для выгрузки цены на МП.
export interface PriceItem {
  externalId: string;
  sku: string;
  price: number;
}

// Позиция заказа МП (для маппинга на наш товар и резерва остатка).
export interface RawOrderItem {
  // SKU/offer_id/баркод позиции на стороне МП — соотносим с listing'ом.
  sku: string;
  // Количество в заказе (по умолчанию 1, если площадка не отдала).
  quantity: number;
  // Цена позиции (в рублях), если доступна.
  price?: number;
}

// Унифицированный сырой заказ, полученный с МП.
export interface RawOrder {
  // Идентификатор заказа на МП (WB orderId, Ozon posting_number).
  externalOrderId: string;
  status: string;
  // Номер отправления (WB rid, Ozon posting_number).
  postingNumber?: string | null;
  totalAmount: number;
  // Позиции заказа (для создания локального draft-Order + резерва). Часть
  // площадок (WB /orders/new) не отдаёт позиции в этом ответе — тогда пусто.
  items?: RawOrderItem[];
  // Полный объект ответа площадки (для разбора позиций/диагностики).
  raw: unknown;
}

// Результат массовой выгрузки (остатки/цены): сколько успешно + ошибки.
export interface PushResult {
  ok: number;
  errors: string[];
}

// Тип fetch, который инжектируется в адаптер (совместим с глобальным fetch).
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

// Интерфейс адаптера площадки.
export interface MarketplaceAdapter {
  readonly platform: MarketplacePlatform;
  // Выгрузить остатки SmartStock → МП.
  pushStocks(items: StockItem[]): Promise<PushResult>;
  // Забрать новые (необработанные) заказы МП → SmartStock.
  fetchNewOrders(since?: Date): Promise<RawOrder[]>;
  // Выгрузить цены (опционально — у части площадок отдельный API).
  pushPrices?(items: PriceItem[]): Promise<PushResult>;
  // Обновить статус заказа на МП (опционально).
  updateOrderStatus?(externalOrderId: string, status: string): Promise<void>;
}

// Параметры конструирования адаптера из аккаунта.
export interface AdapterAccount {
  platform: MarketplacePlatform;
  apiKey: string;
  // Для Ozon — Client-Id; для Яндекс.Маркета — campaignId (id магазина-кампании).
  clientId?: string | null;
  // Идентификатор склада на стороне МП (WB warehouseId; Ozon/Яндекс warehouse_id).
  externalWarehouseId?: string | null;
}
