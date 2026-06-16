// Адаптер СберМегаМаркет (Merchant API, схема FBS/«отгрузки»).
//
// Реальные эндпоинты (база https://api.megamarket.tech). ВСЕ вызовы — POST с
// конвертом {meta:{}, data:{token, ...}}; токен продавца передаётся В ТЕЛЕ
// (data.token), НЕ в заголовке. HTTP обычно 200 даже при логической ошибке —
// успех определяется полем success (1 — ок, 0 — ошибка).
//   остатки  POST /api/merchantIntegration/v1/offerService/stock/update
//            data:{token, stocks:[{offerId, quantity}]}
//   цены     POST /api/merchantIntegration/v1/offerService/manualPrice/save
//            data:{token, prices:[{offerId, price, isDeleted:false}]}
//   заказы   POST /api/market/v1/orderService/order/new
//            data:{token} → {data:{shipments:[{shipmentId, items:[{offerId, price, quantity}]}]}}
//
// Сетевые вызовы идут через fetchWithRetry (ретрай на 429/5xx). fetch
// инжектируется (в проде — глобальный fetch Node), тесты подставляют фейк.
// ПОМЕТКА: формат конверта/методы соответствуют Merchant API; перед боевым
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

const SBER_BASE = 'https://api.megamarket.tech';

export interface SberAdapterOptions {
  fetchImpl: FetchLike;
  baseUrl?: string;
  retry?: RetryOptions;
}

export class SberAdapter implements MarketplaceAdapter {
  readonly platform = 'sber' as const;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly retry?: RetryOptions;

  constructor(
    private readonly account: AdapterAccount,
    opts: SberAdapterOptions,
  ) {
    this.fetchImpl = opts.fetchImpl;
    this.baseUrl = opts.baseUrl ?? SBER_BASE;
    this.retry = opts.retry;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json' };
  }

  // Конверт запроса: токен всегда в data.token.
  private envelope(data: Record<string, unknown>): string {
    return JSON.stringify({ meta: {}, data: { token: this.account.apiKey, ...data } });
  }

  // POST /api/merchantIntegration/v1/offerService/stock/update
  async pushStocks(items: StockItem[]): Promise<PushResult> {
    if (items.length === 0) {
      return { ok: 0, errors: [] };
    }
    const body = this.envelope({
      stocks: items.map((i) => ({ offerId: i.sku, quantity: Math.max(0, Math.trunc(i.qty)) })),
    });
    try {
      const res = await fetchWithRetry(
        this.fetchImpl,
        `${this.baseUrl}/api/merchantIntegration/v1/offerService/stock/update`,
        { method: 'POST', headers: this.headers(), body },
        this.retry,
      );
      if (!res.ok) {
        const text = await safeText(res);
        return { ok: 0, errors: [`Сбер остатки: HTTP ${res.status} ${text}`] };
      }
      const data = (await res.json()) as SberResponse | null;
      if (!isSuccess(data)) {
        return { ok: 0, errors: [`Сбер остатки: ${sberError(data)}`] };
      }
      return { ok: items.length, errors: [] };
    } catch (err) {
      return { ok: 0, errors: [`Сбер остатки: сетевая ошибка ${errMsg(err)}`] };
    }
  }

  // POST /api/merchantIntegration/v1/offerService/manualPrice/save
  async pushPrices(items: PriceItem[]): Promise<PushResult> {
    if (items.length === 0) {
      return { ok: 0, errors: [] };
    }
    const body = this.envelope({
      prices: items.map((i) => ({ offerId: i.sku, price: i.price, isDeleted: false })),
    });
    try {
      const res = await fetchWithRetry(
        this.fetchImpl,
        `${this.baseUrl}/api/merchantIntegration/v1/offerService/manualPrice/save`,
        { method: 'POST', headers: this.headers(), body },
        this.retry,
      );
      if (!res.ok) {
        const text = await safeText(res);
        return { ok: 0, errors: [`Сбер цены: HTTP ${res.status} ${text}`] };
      }
      const data = (await res.json()) as SberResponse | null;
      if (!isSuccess(data)) {
        return { ok: 0, errors: [`Сбер цены: ${sberError(data)}`] };
      }
      return { ok: items.length, errors: [] };
    } catch (err) {
      return { ok: 0, errors: [`Сбер цены: сетевая ошибка ${errMsg(err)}`] };
    }
  }

  // POST /api/market/v1/orderService/order/new → {data:{shipments:[...]}}
  // _since не используется намеренно: эндпоint order/new сам по себе возвращает
  // ТОЛЬКО новые отгрузки (уже обработанные сюда не попадают), инкрементальное
  // окно по дате этим методом не поддерживается. Параметр оставлен для
  // единообразия интерфейса MarketplaceAdapter.
  async fetchNewOrders(_since?: Date): Promise<RawOrder[]> {
    let res;
    try {
      res = await fetchWithRetry(
        this.fetchImpl,
        `${this.baseUrl}/api/market/v1/orderService/order/new`,
        { method: 'POST', headers: this.headers(), body: this.envelope({}) },
        this.retry,
      );
    } catch (err) {
      throw new Error(`Сбер заказы: сетевая ошибка ${errMsg(err)}`);
    }
    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`Сбер заказы: HTTP ${res.status} ${text}`);
    }
    const data = (await res.json()) as SberOrdersResponse | null;
    if (!isSuccess(data)) {
      throw new Error(`Сбер заказы: ${sberError(data)}`);
    }
    const shipments = data?.data?.shipments ?? [];
    return shipments.map((s): RawOrder => ({
      externalOrderId: String(s.shipmentId ?? s.orderId ?? ''),
      status: s.status ?? 'NEW',
      postingNumber: s.shipmentId != null ? String(s.shipmentId) : null,
      totalAmount: (s.items ?? []).reduce((acc, it) => {
        const price = Number(it.price ?? 0);
        const qty = it.quantity ?? it.count ?? 1;
        return acc + (Number.isFinite(price) ? price : 0) * qty;
      }, 0),
      items: (s.items ?? [])
        .map((it) => {
          const sku = it.offerId ?? (it.goodsId != null ? String(it.goodsId) : '');
          const price = Number(it.price);
          return {
            sku,
            quantity: it.quantity ?? it.count ?? 1,
            ...(Number.isFinite(price) ? { price } : {}),
          };
        })
        .filter((it) => it.sku !== ''),
      raw: s,
    })).filter((o) => o.externalOrderId !== '');
  }
}

interface SberResponse {
  success?: number;
  error?: unknown;
  meta?: unknown;
}

interface SberShipmentItem {
  offerId?: string;
  goodsId?: string | number;
  price?: number | string;
  quantity?: number;
  count?: number;
}

interface SberShipment {
  shipmentId?: string | number;
  orderId?: string | number;
  status?: string;
  items?: SberShipmentItem[];
}

interface SberOrdersResponse extends SberResponse {
  data?: { shipments?: SberShipment[] };
}

// Успех СберМегаМаркета — поле success === 1 (HTTP может быть 200 при ошибке).
function isSuccess(data: SberResponse | null): boolean {
  return data?.success === 1;
}

function sberError(data: SberResponse | null): string {
  if (data?.error != null) {
    return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
  }
  return 'success != 1';
}

export function createSberAdapter(account: AdapterAccount, fetchImpl: FetchLike): SberAdapter {
  return new SberAdapter(account, { fetchImpl });
}
