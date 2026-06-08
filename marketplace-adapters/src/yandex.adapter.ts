// Адаптер Яндекс.Маркет (Partner API, схема FBS — модель «магазин/кампания»).
//
// Реальные эндпоинты (база https://api.partner.market.yandex.ru):
//   остатки  PUT  /campaigns/{campaignId}/offers/stocks
//            тело {skus:[{sku, warehouseId?, items:[{count, updatedAt}]}]}
//   заказы   GET  /campaigns/{campaignId}/orders?status=PROCESSING&fromDate=DD-MM-YYYY
//            → {orders:[{id, status, items:[{offerId, count, price}], ...}]}
//   цены     POST /campaigns/{campaignId}/offer-prices/updates
//            тело {offers:[{offerId, price:{value, currencyId:"RUR"}}]}
// Авторизация: заголовок Api-Key: <токен продавца> (актуальный способ Partner API).
// campaignId (идентификатор магазина-кампании) берём из account.clientId.
//
// Сетевые вызовы идут через fetchWithRetry (ретрай на 429/5xx). fetch
// инжектируется (в проде — глобальный fetch Node), тесты подставляют фейк.
// ПОМЕТКА: эндпоинты соответствуют документации Partner API; перед боевым
// использованием сверить с конкретным кабинетом продавца (как и для WB/Ozon).

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

const YANDEX_BASE = 'https://api.partner.market.yandex.ru';
// Размер страницы и верхний предел страниц при выборке заказов.
const ORDERS_PAGE_LIMIT = 50;
const ORDERS_MAX_PAGES = 20;

export interface YandexAdapterOptions {
  fetchImpl: FetchLike;
  baseUrl?: string;
  retry?: RetryOptions;
}

export class YandexAdapter implements MarketplaceAdapter {
  readonly platform = 'yandex' as const;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly retry?: RetryOptions;

  constructor(
    private readonly account: AdapterAccount,
    opts: YandexAdapterOptions,
  ) {
    this.fetchImpl = opts.fetchImpl;
    this.baseUrl = opts.baseUrl ?? YANDEX_BASE;
    this.retry = opts.retry;
  }

  private headers(): Record<string, string> {
    return {
      'Api-Key': this.account.apiKey,
      'Content-Type': 'application/json',
    };
  }

  // campaignId магазина — обязателен для всех вызовов Partner API.
  private campaignId(): string | null {
    return this.account.clientId ?? null;
  }

  // PUT /campaigns/{campaignId}/offers/stocks
  async pushStocks(items: StockItem[]): Promise<PushResult> {
    const campaignId = this.campaignId();
    if (!campaignId) {
      return { ok: 0, errors: ['Не указан clientId (campaignId магазина Яндекс.Маркет)'] };
    }
    if (items.length === 0) {
      return { ok: 0, errors: [] };
    }
    const warehouseId = this.account.externalWarehouseId;
    const body = {
      skus: items.map((i) => ({
        sku: i.sku,
        ...(warehouseId ? { warehouseId: Number(warehouseId) } : {}),
        items: [{ count: Math.max(0, Math.trunc(i.qty)) }],
      })),
    };
    try {
      const res = await fetchWithRetry(
        this.fetchImpl,
        `${this.baseUrl}/campaigns/${encodeURIComponent(campaignId)}/offers/stocks`,
        { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) },
        this.retry,
      );
      if (!res.ok) {
        const text = await safeText(res);
        return { ok: 0, errors: [`Яндекс остатки: HTTP ${res.status} ${text}`] };
      }
      // Ответ {status:"OK"} либо {status:"ERROR", errors:[...]}.
      const data = (await res.json()) as YandexStatusResponse | null;
      if (data && data.status === 'ERROR') {
        const msg = (data.errors ?? []).map((e) => e.message ?? e.code ?? '').join('; ');
        return { ok: 0, errors: [`Яндекс остатки: ${msg || 'ERROR'}`] };
      }
      return { ok: items.length, errors: [] };
    } catch (err) {
      return { ok: 0, errors: [`Яндекс остатки: сетевая ошибка ${errMsg(err)}`] };
    }
  }

  // POST /campaigns/{campaignId}/offer-prices/updates
  async pushPrices(items: PriceItem[]): Promise<PushResult> {
    const campaignId = this.campaignId();
    if (!campaignId) {
      return { ok: 0, errors: ['Не указан clientId (campaignId магазина Яндекс.Маркет)'] };
    }
    if (items.length === 0) {
      return { ok: 0, errors: [] };
    }
    const body = {
      offers: items.map((i) => ({
        offerId: i.sku,
        price: { value: i.price, currencyId: 'RUR' },
      })),
    };
    try {
      const res = await fetchWithRetry(
        this.fetchImpl,
        `${this.baseUrl}/campaigns/${encodeURIComponent(campaignId)}/offer-prices/updates`,
        { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
        this.retry,
      );
      if (!res.ok) {
        const text = await safeText(res);
        return { ok: 0, errors: [`Яндекс цены: HTTP ${res.status} ${text}`] };
      }
      const data = (await res.json()) as YandexStatusResponse | null;
      if (data && data.status === 'ERROR') {
        const msg = (data.errors ?? []).map((e) => e.message ?? e.code ?? '').join('; ');
        return { ok: 0, errors: [`Яндекс цены: ${msg || 'ERROR'}`] };
      }
      return { ok: items.length, errors: [] };
    } catch (err) {
      return { ok: 0, errors: [`Яндекс цены: сетевая ошибка ${errMsg(err)}`] };
    }
  }

  // GET /campaigns/{campaignId}/orders?status=PROCESSING&page=N
  // Пагинация по pager.pagesCount; верхний предел ORDERS_MAX_PAGES — защита от цикла.
  async fetchNewOrders(_since?: Date): Promise<RawOrder[]> {
    const campaignId = this.campaignId();
    if (!campaignId) {
      throw new Error('Не указан clientId (campaignId магазина Яндекс.Маркет)');
    }
    const all: YandexOrder[] = [];
    let page = 1;
    for (;;) {
      const url =
        `${this.baseUrl}/campaigns/${encodeURIComponent(campaignId)}/orders` +
        `?status=PROCESSING&page=${page}&pageSize=${ORDERS_PAGE_LIMIT}`;
      let res;
      try {
        res = await fetchWithRetry(
          this.fetchImpl,
          url,
          { method: 'GET', headers: this.headers() },
          this.retry,
        );
      } catch (err) {
        throw new Error(`Яндекс заказы: сетевая ошибка ${errMsg(err)}`);
      }
      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(`Яндекс заказы: HTTP ${res.status} ${text}`);
      }
      const data = (await res.json()) as YandexOrdersResponse | null;
      const orders = data?.orders ?? [];
      all.push(...orders);

      const pagesCount = data?.pager?.pagesCount ?? 1;
      if (page >= pagesCount || orders.length === 0) {
        break;
      }
      if (page >= ORDERS_MAX_PAGES) {
        // eslint-disable-next-line no-console
        console.warn(
          `[yandex] выборка заказов ограничена ${ORDERS_MAX_PAGES} страницами; ` +
            'часть заказов могла не попасть',
        );
        break;
      }
      page += 1;
    }

    return all.map((o): RawOrder => ({
      externalOrderId: String(o.id ?? ''),
      status: o.status ?? 'PROCESSING',
      postingNumber: o.id != null ? String(o.id) : null,
      totalAmount: (o.items ?? []).reduce((s, it) => {
        const price = Number(it.price ?? 0);
        const count = it.count ?? 1;
        return s + (Number.isFinite(price) ? price : 0) * count;
      }, 0),
      items: (o.items ?? [])
        .map((it) => {
          const sku = it.offerId ?? (it.shopSku != null ? String(it.shopSku) : '');
          const price = Number(it.price);
          return {
            sku,
            quantity: it.count ?? 1,
            ...(Number.isFinite(price) ? { price } : {}),
          };
        })
        .filter((it) => it.sku !== ''),
      raw: o,
    }));
  }
}

interface YandexStatusResponse {
  status?: 'OK' | 'ERROR';
  errors?: { code?: string; message?: string }[];
}

interface YandexOrderItem {
  offerId?: string;
  shopSku?: string;
  count?: number;
  price?: number | string;
}

interface YandexOrder {
  id?: number | string;
  status?: string;
  items?: YandexOrderItem[];
}

interface YandexOrdersResponse {
  orders?: YandexOrder[];
  pager?: { pagesCount?: number; total?: number };
}

export function createYandexAdapter(account: AdapterAccount, fetchImpl: FetchLike): YandexAdapter {
  return new YandexAdapter(account, { fetchImpl });
}
