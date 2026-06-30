// Адаптер Wildberries (Suppliers / Marketplace API, схема FBS).
//
// Реальные эндпоинты (база https://marketplace-api.wildberries.ru):
//   остатки  PUT  /api/v3/stocks/{warehouseId}   тело {stocks:[{sku, amount}]}
//   заказы   GET  /api/v3/orders/new              → {orders:[...]}
//   цены     — отдельный сервис discounts-prices (https://discounts-prices-api.wildberries.ru,
//              POST /api/v2/upload/task) тело {data:[{nmID, price, discount?}]}
//   карточки — Content API (https://content-api.wildberries.ru,
//              POST /content/v2/get/cards/list) → {cards:[{nmID, sizes:[{skus:[...]}]}], cursor}
//
// ВЫГРУЗКА ЦЕН: сервис цен WB принимает ТОЛЬКО числовой nmID карточки, а наш
// каталог сопоставляется по ШТРИХКОДУ (sku). Поэтому при выгрузке цен, если в
// PriceItem нет валидного nmID (externalId), адаптер сам тянет карточки продавца
// через Content API и строит карту штрихкод→nmID (см. loadCardNmIdMap). Раньше
// выгрузка цен WB была недоступна именно из-за отсутствия nmID — теперь работает.
//
// Авторизация: заголовок Authorization: <apiKey> (токен продавца WB; один токен
// с правами на контент+цены+маркетплейс). Сетевые вызовы — через fetchWithRetry
// (ретрай на 429/5xx). fetch инжектируется; тесты подставляют фейк.

import { fetchWithRetry, safeText, errMsg, type RetryOptions } from './http';
import { parseWbFinanceReport, jllInt, type FinanceLine } from './finance';
import type {
  AdapterAccount,
  FetchLike,
  MarketplaceAdapter,
  PriceItem,
  PushResult,
  RawOrder,
  StockItem,
} from './types';

// База Marketplace API WB (остатки/заказы FBS).
const WB_BASE = 'https://marketplace-api.wildberries.ru';
// База сервиса цен WB (discounts-prices-api) — отдельный хост от остатков/заказов.
const WB_PRICE_BASE = 'https://discounts-prices-api.wildberries.ru';
// База Content API WB (карточки товара) — для резолва nmID по штрихкоду.
const WB_CONTENT_BASE = 'https://content-api.wildberries.ru';
// База Statistics API WB (финотчёт reportDetailByPeriod).
const WB_STATS_BASE = 'https://statistics-api.wildberries.ru';
// Размер страницы и верхний предел страниц при выгрузке карточек (защита от цикла).
const CARDS_PAGE_LIMIT = 100;
const CARDS_MAX_PAGES = 100; // до 10000 карточек
// Финотчёт: размер страницы курсора rrdid и потолок страниц (защита от цикла).
const FIN_PAGE_LIMIT = 100000;
const FIN_MAX_PAGES = 200;

export interface WbAdapterOptions {
  fetchImpl: FetchLike;
  baseUrl?: string;
  // База сервиса цен (discounts-prices) — переопределяется в тестах.
  priceBaseUrl?: string;
  // База Content API (карточки) — переопределяется в тестах.
  contentBaseUrl?: string;
  // База Statistics API (финотчёт) — переопределяется в тестах.
  statsBaseUrl?: string;
  // Опции ретрая сетевых вызовов (в тестах — нулевая задержка).
  retry?: RetryOptions;
}

export class WbAdapter implements MarketplaceAdapter {
  readonly platform = 'wb' as const;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly priceBaseUrl: string;
  private readonly contentBaseUrl: string;
  private readonly statsBaseUrl: string;
  private readonly retry?: RetryOptions;

  constructor(
    private readonly account: AdapterAccount,
    opts: WbAdapterOptions,
  ) {
    this.fetchImpl = opts.fetchImpl;
    this.baseUrl = opts.baseUrl ?? WB_BASE;
    this.priceBaseUrl = opts.priceBaseUrl ?? WB_PRICE_BASE;
    this.contentBaseUrl = opts.contentBaseUrl ?? WB_CONTENT_BASE;
    this.statsBaseUrl = opts.statsBaseUrl ?? WB_STATS_BASE;
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

  // Резолв nmID по штрихкоду через Content API: POST /content/v2/get/cards/list.
  // Пагинация по cursor (limit + nmID/updatedAt последней карточки), пока страница
  // приходит полной. Возвращает карту штрихкод(sku) → nmID. Бросает при HTTP-ошибке.
  async loadCardNmIdMap(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    let cursor: { limit: number; nmID?: number; updatedAt?: string } = {
      limit: CARDS_PAGE_LIMIT,
    };
    for (let page = 0; page < CARDS_MAX_PAGES; page += 1) {
      const body = { settings: { cursor, filter: { withPhoto: -1 } } };
      const res = await fetchWithRetry(
        this.fetchImpl,
        `${this.contentBaseUrl}/content/v2/get/cards/list`,
        { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
        this.retry,
      );
      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(`WB карточки: HTTP ${res.status} ${text}`);
      }
      const data = (await res.json()) as WbCardsResponse | null;
      const cards = data?.cards ?? [];
      for (const c of cards) {
        if (c.nmID == null) continue;
        for (const s of c.sizes ?? []) {
          for (const sku of s.skus ?? []) {
            if (sku) map.set(String(sku), c.nmID);
          }
        }
      }
      // Неполная страница (или нет курсора) — карточки закончились.
      if (cards.length < CARDS_PAGE_LIMIT || !data?.cursor) break;
      cursor = {
        limit: CARDS_PAGE_LIMIT,
        nmID: data.cursor.nmID,
        updatedAt: data.cursor.updatedAt,
      };
    }
    return map;
  }

  // POST /api/v2/upload/task  {data:[{nmID, price}]} (сервис цен).
  // nmID берём из PriceItem.externalId (если это валидное целое > 0); иначе
  // резолвим по штрихкоду (sku) через Content API. Непривязанные позиции уходят
  // в errors, остальные отправляются.
  async pushPrices(items: PriceItem[]): Promise<PushResult> {
    if (items.length === 0) {
      return { ok: 0, errors: [] };
    }
    const errors: string[] = [];
    const data: { nmID: number; price: number }[] = [];
    const needResolve: PriceItem[] = [];
    for (const i of items) {
      const nmID = Number(i.externalId);
      // nmID WB — положительное ЦЕЛОЕ. Number.isInteger отсекает '1.5'/'1e3'/'0x1F'.
      if (Number.isInteger(nmID) && nmID > 0) {
        data.push({ nmID, price: i.price });
      } else {
        // externalId не nmID (у нас сопоставление по штрихкоду) — резолвим ниже.
        needResolve.push(i);
      }
    }
    if (needResolve.length > 0) {
      let cardMap: Map<string, number> | null = null;
      try {
        cardMap = await this.loadCardNmIdMap();
      } catch (err) {
        // Карточки не получили — все нерезолвенные позиции в ошибки, валидные шлём.
        for (const i of needResolve) {
          errors.push(`WB цены: не удалось получить nmID для sku='${i.sku}' (${errMsg(err)})`);
        }
      }
      if (cardMap) {
        for (const i of needResolve) {
          const nmID = cardMap.get(i.sku);
          if (nmID != null && Number.isInteger(nmID) && nmID > 0) {
            data.push({ nmID, price: i.price });
          } else {
            errors.push(`WB цены: карточка с nmID по штрихкоду '${i.sku}' не найдена — пропущено`);
          }
        }
      }
    }
    if (data.length === 0) {
      // Нечего отправлять (все позиции невалидны/не сопоставлены) — только ошибки.
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
    }).filter((o) => o.externalOrderId !== '');
  }

  // GET /api/v5/supplier/reportDetailByPeriod — финотчёт о реализации за период.
  // Пагинация по курсору rrdid (макс. rrd_id предыдущей страницы). Токен —
  // категории «Статистика» (statsApiKey; если пуст — общий apiKey). Бросает при
  // сетевой/HTTP-ошибке (вызывающий в UI прогоняет через ErrorMapper).
  //
  // ⚠ МИГРАЦИЯ WB (дедлайн 15.07.2026): reportDetailByPeriod отключается, замена —
  // POST /api/finance/v1/sales-reports/detailed (другие имена полей). До миграции и
  // при сбое API фолбэк — импорт из файла кабинета (parseWbFinanceTable).
  async fetchFinanceLines(dateFrom: string, dateTo: string): Promise<FinanceLine[]> {
    const token = this.account.statsApiKey || this.account.apiKey;
    const all: FinanceLine[] = [];
    let rrdid = 0;
    for (let page = 0; page < FIN_MAX_PAGES; page += 1) {
      const url =
        `${this.statsBaseUrl}/api/v5/supplier/reportDetailByPeriod` +
        `?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}` +
        `&limit=${FIN_PAGE_LIMIT}&rrdid=${rrdid}`;
      let res;
      try {
        res = await fetchWithRetry(
          this.fetchImpl,
          url,
          { method: 'GET', headers: { Authorization: token } },
          this.retry,
        );
      } catch (err) {
        throw new Error(`WB финансы: сетевая ошибка ${errMsg(err)}`);
      }
      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(`WB финансы: HTTP ${res.status} ${text}`);
      }
      const j = (await res.json()) as unknown;
      // Пустой ответ (null/[]) — данных больше нет.
      if (j == null || (Array.isArray(j) && j.length === 0)) break;
      const before = all.length;
      for (const ln of parseWbFinanceReport(j)) all.push(ln);
      // Сдвигаем курсор на максимальный rrd_id страницы.
      let maxRrd = rrdid;
      let rows: number;
      if (Array.isArray(j)) {
        rows = j.length;
        for (const r of j) {
          if (r && typeof r === 'object' && 'rrd_id' in r) {
            maxRrd = Math.max(maxRrd, jllInt((r as Record<string, unknown>).rrd_id));
          }
        }
      } else {
        rows = all.length - before;
      }
      if (rows < FIN_PAGE_LIMIT) break; // последняя (неполная) страница
      if (maxRrd <= rrdid) break; // курсор не двигается — стоп
      rrdid = maxRrd;
    }
    return all;
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

// Ответ Content API /content/v2/get/cards/list.
interface WbCard {
  nmID?: number;
  sizes?: { skus?: (string | number)[] }[];
}
interface WbCardsResponse {
  cards?: WbCard[];
  cursor?: { total?: number; nmID?: number; updatedAt?: string };
}

export function createWbAdapter(account: AdapterAccount, fetchImpl: FetchLike): WbAdapter {
  return new WbAdapter(account, { fetchImpl });
}
