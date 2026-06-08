// Адаптер Wildberries (Suppliers / Marketplace API, схема FBS).
//
// Реальные эндпоинты (база https://marketplace-api.wildberries.ru):
//   остатки  PUT  /api/v3/stocks/{warehouseId}   тело {stocks:[{sku, amount}]}
//   заказы   GET  /api/v3/orders/new              → {orders:[...]}
//   цены     — отдельный сервис discounts-prices (https://discounts-prices-api.wildberries.ru,
//              POST /api/v2/upload/task) тело {data:[{nmID, price, discount?}]}
// Авторизация: заголовок Authorization: <apiKey> (токен продавца WB).
//
// Сетевые вызовы идут через fetchWithRetry (ретрай на 429/5xx). fetch
// инжектируется (в проде — глобальный fetch Node), тесты подставляют фейк.

import { fetchWithRetry, safeText, errMsg, type RetryOptions } from './http';
import type {
  AdapterAccount,
  FetchLike,
  MarketplaceAdapter,
  PriceItem,
  PushResult,
  RawOrder,
  StockItem,
} from './types';

// База Marketplace API WB (остатки/заказы FBS). Вынесена в константу — при
// необходимости можно переопределить через конструктор.
const WB_BASE = 'https://marketplace-api.wildberries.ru';
// База сервиса цен WB (discounts-prices-api) — отдельный хост от остатков/заказов.
const WB_PRICE_BASE = 'https://discounts-prices-api.wildberries.ru';

export interface WbAdapterOptions {
  fetchImpl: FetchLike;
  baseUrl?: string;
  // База сервиса цен (discounts-prices) — переопределяется в тестах.
  priceBaseUrl?: string;
  // Опции ретрая сетевых вызовов (в тестах — нулевая задержка).
  retry?: RetryOptions;
}

export class WbAdapter implements MarketplaceAdapter {
  readonly platform = 'wb' as const;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly priceBaseUrl: string;
  private readonly retry?: RetryOptions;

  constructor(
    private readonly account: AdapterAccount,
    opts: WbAdapterOptions,
  ) {
    this.fetchImpl = opts.fetchImpl;
    this.baseUrl = opts.baseUrl ?? WB_BASE;
    this.priceBaseUrl = opts.priceBaseUrl ?? WB_PRICE_BASE;
    this.retry = opts.retry;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: this.account.apiKey,
      'Content-Type': 'application/json',
    };
  }

  // PUT /api/v3/stocks/{warehouseId}  {stocks:[{sku, amount}]}
  async pushStocks(items: StockItem[]): Promise<PushResult> {
    const warehouseId = this.account.externalWarehouseId;
    if (!warehouseId) {
      return { ok: 0, errors: ['Не указан externalWarehouseId склада WB'] };
    }
    if (items.length === 0) {
      return { ok: 0, errors: [] };
    }
    const body = {
      stocks: items.map((i) => ({ sku: i.sku, amount: Math.max(0, Math.trunc(i.qty)) })),
    };
    try {
      const res = await fetchWithRetry(
        this.fetchImpl,
        `${this.baseUrl}/api/v3/stocks/${encodeURIComponent(warehouseId)}`,
        { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) },
        this.retry,
      );
      if (!res.ok) {
        const text = await safeText(res);
        return { ok: 0, errors: [`WB остатки: HTTP ${res.status} ${text}`] };
      }
      return { ok: items.length, errors: [] };
    } catch (err) {
      return { ok: 0, errors: [`WB остатки: сетевая ошибка ${errMsg(err)}`] };
    }
  }

  // POST /api/v2/upload/task  {data:[{nmID, price, discount?}]} (сервис цен).
  // externalId listing'а для WB — это nmID (числовой ID карточки). Нечисловой
  // externalId не маппится — позиция уходит в errors, остальные отправляются.
  async pushPrices(items: PriceItem[]): Promise<PushResult> {
    if (items.length === 0) {
      return { ok: 0, errors: [] };
    }
    const errors: string[] = [];
    const data: { nmID: number; price: number }[] = [];
    for (const i of items) {
      const nmID = Number(i.externalId);
      // nmID WB — положительное ЦЕЛОЕ. Number.isFinite пропускал бы '1.5',
      // '1e3', '0x1F' → чужая/битая карточка (находка ревью). Требуем integer>0.
      if (!Number.isInteger(nmID) || nmID <= 0) {
        errors.push(`WB цены: некорректный nmID '${i.externalId}' (sku=${i.sku}) — пропущен`);
        continue;
      }
      data.push({ nmID, price: i.price });
    }
    if (data.length === 0) {
      // Нечего отправлять (все позиции невалидны) — только ошибки.
      return { ok: 0, errors };
    }
    try {
      const res = await fetchWithRetry(
        this.fetchImpl,
        `${this.priceBaseUrl}/api/v2/upload/task`,
        { method: 'POST', headers: this.headers(), body: JSON.stringify({ data }) },
        this.retry,
      );
      if (!res.ok) {
        const text = await safeText(res);
        errors.push(`WB цены: HTTP ${res.status} ${text}`);
        return { ok: 0, errors };
      }
      return { ok: data.length, errors };
    } catch (err) {
      errors.push(`WB цены: сетевая ошибка ${errMsg(err)}`);
      return { ok: 0, errors };
    }
  }

  // GET /api/v3/orders/new → {orders:[...]}
  async fetchNewOrders(): Promise<RawOrder[]> {
    let res;
    try {
      res = await fetchWithRetry(
        this.fetchImpl,
        `${this.baseUrl}/api/v3/orders/new`,
        { method: 'GET', headers: this.headers() },
        this.retry,
      );
    } catch (err) {
      throw new Error(`WB заказы: сетевая ошибка ${errMsg(err)}`);
    }
    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`WB заказы: HTTP ${res.status} ${text}`);
    }
    const data = (await res.json()) as { orders?: WbOrder[] } | null;
    const orders = data?.orders ?? [];
    return orders.map((o): RawOrder => {
      // WB FBS-заказ — одна позиция: идентификатор берём из skus[0] (баркод),
      // иначе article, иначе nmId. Цена — convertedPrice/price в копейках.
      const price = ((o.convertedPrice ?? o.price ?? 0) as number) / 100;
      const sku =
        (Array.isArray(o.skus) && o.skus.length > 0 ? String(o.skus[0]) : undefined) ??
        o.article ??
        (o.nmId != null ? String(o.nmId) : undefined);
      return {
        externalOrderId: String(o.id ?? o.rid ?? ''),
        status: o.status ?? 'new',
        postingNumber: o.rid != null ? String(o.rid) : null,
        totalAmount: price,
        items: sku ? [{ sku, quantity: 1, price }] : [],
        raw: o,
      };
    });
  }
}

interface WbOrder {
  id?: number | string;
  rid?: string;
  status?: string;
  price?: number;
  convertedPrice?: number;
  // Идентификаторы товара для маппинга на наш каталог.
  skus?: (string | number)[];
  article?: string;
  nmId?: number | string;
}

export function createWbAdapter(account: AdapterAccount, fetchImpl: FetchLike): WbAdapter {
  return new WbAdapter(account, { fetchImpl });
}
