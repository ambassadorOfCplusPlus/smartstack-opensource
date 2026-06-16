// Адаптер Ozon (Seller API, схема FBS).
//
// Реальные эндпоинты (база https://api-seller.ozon.ru):
//   остатки  POST /v2/products/stocks
//            тело {stocks:[{offer_id, stock, warehouse_id}]}
//   заказы   POST /v3/posting/fbs/unfulfilled/list
//            тело {dir, filter:{cutoff_from, cutoff_to}, limit, offset} → {result:{postings:[...]}}
//   цены     POST /v1/product/import/prices  {prices:[{offer_id, price}]}
// Авторизация: заголовки Client-Id: <clientId>, Api-Key: <apiKey>.
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

const OZON_BASE = 'https://api-seller.ozon.ru';
// Размер страницы и верхний предел страниц при выборке необработанных заказов.
const ORDERS_PAGE_LIMIT = 100;
const ORDERS_MAX_PAGES = 20;

export interface OzonAdapterOptions {
  fetchImpl: FetchLike;
  baseUrl?: string;
  // Опции ретрая сетевых вызовов (в тестах — нулевая задержка).
  retry?: RetryOptions;
}

export class OzonAdapter implements MarketplaceAdapter {
  readonly platform = 'ozon' as const;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly retry?: RetryOptions;

  constructor(
    private readonly account: AdapterAccount,
    opts: OzonAdapterOptions,
  ) {
    this.fetchImpl = opts.fetchImpl;
    this.baseUrl = opts.baseUrl ?? OZON_BASE;
    this.retry = opts.retry;
  }

  private headers(): Record<string, string> {
    return {
      'Client-Id': this.account.clientId ?? '',
      'Api-Key': this.account.apiKey,
      'Content-Type': 'application/json',
    };
  }

  // POST /v2/products/stocks  {stocks:[{offer_id, stock, warehouse_id}]}
  async pushStocks(items: StockItem[]): Promise<PushResult> {
    if (items.length === 0) {
      return { ok: 0, errors: [] };
    }
    const warehouseId = this.account.externalWarehouseId;
    const body = {
      stocks: items.map((i) => ({
        offer_id: i.sku,
        stock: Math.max(0, Math.trunc(i.qty)),
        ...(warehouseId ? { warehouse_id: Number(warehouseId) } : {}),
      })),
    };
    try {
      const res = await fetchWithRetry(
        this.fetchImpl,
        `${this.baseUrl}/v2/products/stocks`,
        { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
        this.retry,
      );
      if (!res.ok) {
        const text = await safeText(res);
        return { ok: 0, errors: [`Ozon остатки: HTTP ${res.status} ${text}`] };
      }
      // Ozon возвращает {result:[{offer_id, updated, errors:[...]}]}.
      const data = (await res.json()) as { result?: OzonStockResult[] } | null;
      const results = data?.result ?? [];
      const errors: string[] = [];
      let ok = 0;
      if (results.length === 0) {
        // Пустой result при HTTP 200 — Ozon ничего НЕ подтвердил (частая причина:
        // не указан/неверный warehouse_id). Не выдаём это за успех, иначе синк
        // молча «обновит» всё, не изменив ничего, и замаскирует ошибку.
        errors.push('Ozon остатки: пустой ответ (result=[]) — обновление не подтверждено');
      } else {
        for (const r of results) {
          if (r.updated && (!r.errors || r.errors.length === 0)) {
            ok += 1;
          } else {
            const msg = (r.errors ?? []).map((e) => e.message ?? e.code ?? '').join('; ');
            errors.push(`Ozon offer_id=${r.offer_id}: ${msg || 'не обновлено'}`);
          }
        }
      }
      return { ok, errors };
    } catch (err) {
      return { ok: 0, errors: [`Ozon остатки: сетевая ошибка ${errMsg(err)}`] };
    }
  }

  // POST /v3/posting/fbs/unfulfilled/list → {result:{postings:[...]}}
  // Пагинация: offset += limit, пока страница приходит полной (== limit).
  // Верхний предел ORDERS_MAX_PAGES страниц — защита от бесконечного цикла;
  // при достижении логируем предупреждение (выборка ограничена).
  async fetchNewOrders(since?: Date): Promise<RawOrder[]> {
    // ВАЖНО: cutoff_from/cutoff_to фильтруют СРОК ОТГРУЗКИ постинга (будущая дата),
    // а НЕ время создания/обновления заказа. Поэтому окно нужно делать ШИРОКИМ,
    // иначе необработанный постинг со сроком отгрузки дальше окна вообще не вернётся
    // (старый баг: cutoff_to = now+7д прятал заказы с дальним дедлайном, а далёкий
    // since задавал бессмысленное окно). Берём now-1д (или since, если он свежий)
    // и now+60д, чтобы захватить все необработанные постинги. Повторную обработку
    // уже импортированных заказов предотвращает идемпотентность (imported/*), а не
    // это окно.
    const dayMs = 24 * 3600 * 1000;
    const wideFrom = Date.now() - dayMs;
    const sinceMs = since ? since.getTime() : Number.NaN;
    // since учитываем, только если он свежее, чем now-1д (иначе окно «уехало» бы назад).
    const fromMs = Number.isFinite(sinceMs) && sinceMs > wideFrom ? sinceMs : wideFrom;
    const cutoffFrom = new Date(fromMs).toISOString();
    const cutoffTo = new Date(Date.now() + 60 * dayMs).toISOString();

    const allPostings: OzonPosting[] = [];
    let offset = 0;
    let page = 0;
    for (;;) {
      const body = {
        dir: 'ASC',
        filter: { cutoff_from: cutoffFrom, cutoff_to: cutoffTo },
        limit: ORDERS_PAGE_LIMIT,
        offset,
      };
      let res;
      try {
        res = await fetchWithRetry(
          this.fetchImpl,
          `${this.baseUrl}/v3/posting/fbs/unfulfilled/list`,
          { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
          this.retry,
        );
      } catch (err) {
        throw new Error(`Ozon заказы: сетевая ошибка ${errMsg(err)}`);
      }
      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(`Ozon заказы: HTTP ${res.status} ${text}`);
      }
      const data = (await res.json()) as { result?: { postings?: OzonPosting[] } } | null;
      const postings = data?.result?.postings ?? [];
      allPostings.push(...postings);
      page += 1;

      // Неполная страница — постингов больше нет, завершаем.
      if (postings.length < ORDERS_PAGE_LIMIT) {
        break;
      }
      // Достигли предела страниц — выборка ограничена, предупреждаем.
      if (page >= ORDERS_MAX_PAGES) {
        // eslint-disable-next-line no-console
        console.warn(
          `[ozon] выборка заказов ограничена ${ORDERS_MAX_PAGES} страницами ` +
            `(${ORDERS_MAX_PAGES * ORDERS_PAGE_LIMIT} заказов); часть заказов могла не попасть`,
        );
        break;
      }
      offset += ORDERS_PAGE_LIMIT;
    }

    return allPostings.map((p): RawOrder => ({
      externalOrderId: String(p.posting_number ?? p.order_id ?? ''),
      status: p.status ?? 'awaiting_packaging',
      postingNumber: p.posting_number ?? null,
      totalAmount: sumPostingPrice(p),
      // Позиции с offer_id/sku — для маппинга на наш товар и резерва.
      items: (p.products ?? [])
        .map((it) => {
          const sku = it.offer_id ?? (it.sku != null ? String(it.sku) : '');
          const price =
            typeof it.price === 'string' ? Number(it.price) : (it.price ?? undefined);
          return {
            sku,
            quantity: it.quantity ?? 1,
            ...(price != null && !Number.isNaN(price) ? { price } : {}),
          };
        })
        .filter((it) => it.sku !== ''),
      raw: p,
    })).filter((o) => o.externalOrderId !== '');
  }

  // POST /v1/product/import/prices  {prices:[{offer_id, price}]}
  async pushPrices(items: PriceItem[]): Promise<PushResult> {
    if (items.length === 0) {
      return { ok: 0, errors: [] };
    }
    const body = {
      prices: items.map((i) => ({ offer_id: i.sku, price: String(i.price) })),
    };
    try {
      const res = await fetchWithRetry(
        this.fetchImpl,
        `${this.baseUrl}/v1/product/import/prices`,
        { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
        this.retry,
      );
      if (!res.ok) {
        const text = await safeText(res);
        return { ok: 0, errors: [`Ozon цены: HTTP ${res.status} ${text}`] };
      }
      return { ok: items.length, errors: [] };
    } catch (err) {
      return { ok: 0, errors: [`Ozon цены: сетевая ошибка ${errMsg(err)}`] };
    }
  }
}

interface OzonStockResult {
  offer_id?: string;
  updated?: boolean;
  errors?: { code?: string; message?: string }[];
}

interface OzonPosting {
  posting_number?: string;
  order_id?: number | string;
  status?: string;
  products?: {
    offer_id?: string;
    sku?: number | string;
    price?: string | number;
    quantity?: number;
  }[];
}

function sumPostingPrice(p: OzonPosting): number {
  const products = p.products ?? [];
  return products.reduce((s, item) => {
    const raw = typeof item.price === 'string' ? Number(item.price) : (item.price ?? 0);
    // Нечисловая цена (NaN) обнулялась бы в totalAmount=NaN → Prisma.Decimal('NaN')
    // роняет ВЕСЬ импорт заказов. Клампим к 0 (находка ревью).
    const price = Number.isFinite(raw) ? raw : 0;
    const qty = item.quantity ?? 1;
    return s + price * qty;
  }, 0);
}

export function createOzonAdapter(account: AdapterAccount, fetchImpl: FetchLike): OzonAdapter {
  return new OzonAdapter(account, { fetchImpl });
}
