// Тесты FBS-адаптеров маркетплейсов. Без живой сети: фейк-fetch записывает вызовы
// и отдаёт заготовленные ответы по очереди. Извлечено из исходного модуля
// SmartStock (блок «marketplaces adapters») — зависит только от адаптеров/типов.

import { describe, it, expect } from 'vitest';
import { WbAdapter } from './wb.adapter';
import { OzonAdapter } from './ozon.adapter';
import { YandexAdapter } from './yandex.adapter';
import { SberAdapter } from './sber.adapter';
import { adapterFor } from './factory';
import type { FetchLike } from './types';

// ── Фейк-fetch: записывает вызовы, отдаёт сценарные ответы по очереди ────────
interface RecordedCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}
interface FakeResponse {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
  throwNetwork?: boolean;
}
function makeFakeFetch(responses: FakeResponse[]) {
  const calls: RecordedCall[] = [];
  let idx = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const r = responses[Math.min(idx, responses.length - 1)];
    idx += 1;
    if (r.throwNetwork) {
      throw new Error('ECONNREFUSED');
    }
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.json,
      text: async () => r.text ?? '',
    };
  };
  return { fetchImpl, calls };
}

describe('marketplaces adapters', () => {
  it('WB pushStocks формирует верный PUT-запрос (URL/заголовок/тело)', async () => {
    const { fetchImpl, calls } = makeFakeFetch([{ ok: true, status: 200 }]);
    const adapter = new WbAdapter(
      { platform: 'wb', apiKey: 'WB_TOKEN_XYZ', externalWarehouseId: '12345' },
      { fetchImpl },
    );
    const res = await adapter.pushStocks([
      { externalId: 'nm1', sku: 'SKU1', barcode: '111', qty: 7 },
    ]);
    expect(res).toEqual({ ok: 1, errors: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://marketplace-api.wildberries.ru/api/v3/stocks/12345',
    );
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].headers?.Authorization).toBe('WB_TOKEN_XYZ');
    expect(calls[0].body).toEqual({ stocks: [{ sku: 'SKU1', amount: 7 }] });
  });

  it('WB pushStocks без externalWarehouseId → ошибка, без сетевого вызова', async () => {
    const { fetchImpl, calls } = makeFakeFetch([{ ok: true, status: 200 }]);
    const adapter = new WbAdapter({ platform: 'wb', apiKey: 'T' }, { fetchImpl });
    const res = await adapter.pushStocks([{ externalId: 'n', sku: 's', qty: 1 }]);
    expect(res.ok).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('WB fetchNewOrders разбирает ответ', async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      {
        ok: true,
        status: 200,
        json: { orders: [{ id: 555, rid: 'rid-1', status: 'new', convertedPrice: 12300 }] },
      },
    ]);
    const adapter = new WbAdapter(
      { platform: 'wb', apiKey: 'T', externalWarehouseId: '1' },
      { fetchImpl },
    );
    const orders = await adapter.fetchNewOrders();
    expect(calls[0].url).toBe('https://marketplace-api.wildberries.ru/api/v3/orders/new');
    expect(orders).toHaveLength(1);
    expect(orders[0].externalOrderId).toBe('555');
    expect(orders[0].totalAmount).toBe(123);
  });

  it('Ozon pushStocks формирует верный POST (Client-Id/Api-Key/offer_id)', async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      { ok: true, status: 200, json: { result: [{ offer_id: 'OF1', updated: true }] } },
    ]);
    const adapter = new OzonAdapter(
      { platform: 'ozon', apiKey: 'OZ_KEY', clientId: 'CL-9', externalWarehouseId: '777' },
      { fetchImpl },
    );
    const res = await adapter.pushStocks([{ externalId: 'OF1', sku: 'OF1', qty: 5 }]);
    expect(res).toEqual({ ok: 1, errors: [] });
    expect(calls[0].url).toBe('https://api-seller.ozon.ru/v2/products/stocks');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers?.['Client-Id']).toBe('CL-9');
    expect(calls[0].headers?.['Api-Key']).toBe('OZ_KEY');
    expect(calls[0].body).toEqual({
      stocks: [{ offer_id: 'OF1', stock: 5, warehouse_id: 777 }],
    });
  });

  it('Ozon fetchNewOrders разбирает posting-список', async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      {
        ok: true,
        status: 200,
        json: {
          result: {
            postings: [
              {
                posting_number: 'P-1',
                status: 'awaiting_packaging',
                products: [{ price: '100.00', quantity: 2 }],
              },
            ],
          },
        },
      },
    ]);
    const adapter = new OzonAdapter(
      { platform: 'ozon', apiKey: 'K', clientId: 'C' },
      { fetchImpl },
    );
    const orders = await adapter.fetchNewOrders();
    expect(calls[0].url).toBe(
      'https://api-seller.ozon.ru/v3/posting/fbs/unfulfilled/list',
    );
    expect(orders[0].externalOrderId).toBe('P-1');
    expect(orders[0].totalAmount).toBe(200);
  });

  it('сетевая ошибка адаптера → errors в отчёте, не краш', async () => {
    const { fetchImpl } = makeFakeFetch([{ ok: false, status: 0, throwNetwork: true }]);
    const adapter = new WbAdapter(
      { platform: 'wb', apiKey: 'T', externalWarehouseId: '1' },
      { fetchImpl },
    );
    const res = await adapter.pushStocks([{ externalId: 'n', sku: 's', qty: 1 }]);
    expect(res.ok).toBe(0);
    expect(res.errors[0]).toContain('сетевая ошибка');
  });

  // ── Яндекс.Маркет ─────────────────────────────────────────────────────────
  it('Yandex pushStocks: PUT /campaigns/{id}/offers/stocks, Api-Key, верное тело', async () => {
    const { fetchImpl, calls } = makeFakeFetch([{ ok: true, status: 200, json: { status: 'OK' } }]);
    const adapter = new YandexAdapter(
      { platform: 'yandex', apiKey: 'YA_KEY', clientId: 'camp-1', externalWarehouseId: '55' },
      { fetchImpl },
    );
    const res = await adapter.pushStocks([{ externalId: 'OF', sku: 'SKU-Y', qty: 9 }]);
    expect(res).toEqual({ ok: 1, errors: [] });
    expect(calls[0].url).toBe(
      'https://api.partner.market.yandex.ru/campaigns/camp-1/offers/stocks',
    );
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].headers?.['Api-Key']).toBe('YA_KEY');
    expect(calls[0].body).toEqual({
      skus: [{ sku: 'SKU-Y', warehouseId: 55, items: [{ count: 9 }] }],
    });
  });

  it('Yandex pushStocks без campaignId (clientId) → ошибка, без сетевого вызова', async () => {
    const { fetchImpl, calls } = makeFakeFetch([{ ok: true, status: 200 }]);
    const adapter = new YandexAdapter({ platform: 'yandex', apiKey: 'K' }, { fetchImpl });
    const res = await adapter.pushStocks([{ externalId: 'n', sku: 's', qty: 1 }]);
    expect(res.ok).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('Yandex fetchNewOrders разбирает заказы и считает сумму по позициям', async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      {
        ok: true,
        status: 200,
        json: {
          orders: [
            {
              id: 9001,
              status: 'PROCESSING',
              items: [
                { offerId: 'A', count: 2, price: 150 },
                { offerId: 'B', count: 1, price: 300 },
              ],
            },
          ],
          pager: { pagesCount: 1 },
        },
      },
    ]);
    const adapter = new YandexAdapter(
      { platform: 'yandex', apiKey: 'K', clientId: 'camp-1' },
      { fetchImpl },
    );
    const orders = await adapter.fetchNewOrders();
    expect(calls[0].url).toContain('/campaigns/camp-1/orders?status=PROCESSING');
    expect(orders).toHaveLength(1);
    expect(orders[0].externalOrderId).toBe('9001');
    expect(orders[0].totalAmount).toBe(600);
    expect(orders[0].items).toEqual([
      { sku: 'A', quantity: 2, price: 150 },
      { sku: 'B', quantity: 1, price: 300 },
    ]);
  });

  it('Yandex pushStocks: status=ERROR → ok:0 с сообщением площадки', async () => {
    const { fetchImpl } = makeFakeFetch([
      { ok: true, status: 200, json: { status: 'ERROR', errors: [{ message: 'bad sku' }] } },
    ]);
    const adapter = new YandexAdapter(
      { platform: 'yandex', apiKey: 'K', clientId: 'c' },
      { fetchImpl },
    );
    const res = await adapter.pushStocks([{ externalId: 'n', sku: 's', qty: 1 }]);
    expect(res.ok).toBe(0);
    expect(res.errors[0]).toContain('bad sku');
  });

  // ── СберМегаМаркет ────────────────────────────────────────────────────────
  it('Sber pushStocks: POST с конвертом {meta,data} и токеном В ТЕЛЕ', async () => {
    const { fetchImpl, calls } = makeFakeFetch([{ ok: true, status: 200, json: { success: 1 } }]);
    const adapter = new SberAdapter({ platform: 'sber', apiKey: 'SBER_TOKEN' }, { fetchImpl });
    const res = await adapter.pushStocks([{ externalId: 'OF', sku: 'OF-1', qty: 4 }]);
    expect(res).toEqual({ ok: 1, errors: [] });
    expect(calls[0].url).toBe(
      'https://api.megamarket.tech/api/merchantIntegration/v1/offerService/stock/update',
    );
    expect(calls[0].method).toBe('POST');
    // Токен НЕ в заголовке, а в data.token.
    expect(calls[0].headers?.Authorization).toBeUndefined();
    expect(calls[0].body).toEqual({
      meta: {},
      data: { token: 'SBER_TOKEN', stocks: [{ offerId: 'OF-1', quantity: 4 }] },
    });
  });

  it('Sber success:0 → ok:0 с текстом ошибки (HTTP 200 при логической ошибке)', async () => {
    const { fetchImpl } = makeFakeFetch([
      { ok: true, status: 200, json: { success: 0, error: 'invalid token' } },
    ]);
    const adapter = new SberAdapter({ platform: 'sber', apiKey: 'T' }, { fetchImpl });
    const res = await adapter.pushStocks([{ externalId: 'n', sku: 's', qty: 1 }]);
    expect(res.ok).toBe(0);
    expect(res.errors[0]).toContain('invalid token');
  });

  it('Sber fetchNewOrders разбирает shipments → RawOrder', async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      {
        ok: true,
        status: 200,
        json: {
          success: 1,
          data: {
            shipments: [
              {
                shipmentId: 'SH-1',
                status: 'NEW',
                items: [{ offerId: 'X', price: 250, quantity: 2 }],
              },
            ],
          },
        },
      },
    ]);
    const adapter = new SberAdapter({ platform: 'sber', apiKey: 'T' }, { fetchImpl });
    const orders = await adapter.fetchNewOrders();
    expect(calls[0].url).toBe(
      'https://api.megamarket.tech/api/market/v1/orderService/order/new',
    );
    expect(orders).toHaveLength(1);
    expect(orders[0].externalOrderId).toBe('SH-1');
    expect(orders[0].totalAmount).toBe(500);
    expect(orders[0].items).toEqual([{ sku: 'X', quantity: 2, price: 250 }]);
  });

  // ── Фабрика ───────────────────────────────────────────────────────────────
  it('adapterFor конструирует все 4 площадки по platform', () => {
    const f: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
    expect(adapterFor({ platform: 'wb', apiKey: 'k' }, f).platform).toBe('wb');
    expect(adapterFor({ platform: 'ozon', apiKey: 'k' }, f).platform).toBe('ozon');
    expect(adapterFor({ platform: 'yandex', apiKey: 'k' }, f).platform).toBe('yandex');
    expect(adapterFor({ platform: 'sber', apiKey: 'k' }, f).platform).toBe('sber');
  });

  it('WB pushPrices: верный URL/заголовок/тело {data:[{nmID, price}]}', async () => {
    const { fetchImpl, calls } = makeFakeFetch([{ ok: true, status: 200 }]);
    const adapter = new WbAdapter(
      { platform: 'wb', apiKey: 'WB_TOKEN_XYZ', externalWarehouseId: '1' },
      { fetchImpl },
    );
    const res = await adapter.pushPrices([
      { externalId: '987654', sku: 'SKU1', price: 1500 },
    ]);
    expect(res).toEqual({ ok: 1, errors: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://discounts-prices-api.wildberries.ru/api/v2/upload/task',
    );
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers?.Authorization).toBe('WB_TOKEN_XYZ');
    expect(calls[0].body).toEqual({ data: [{ nmID: 987654, price: 1500 }] });
  });

  it('WB pushPrices: priceBaseUrl переопределяется через конструктор', async () => {
    const { fetchImpl, calls } = makeFakeFetch([{ ok: true, status: 200 }]);
    const adapter = new WbAdapter(
      { platform: 'wb', apiKey: 'T', externalWarehouseId: '1' },
      { fetchImpl, priceBaseUrl: 'https://fake-prices.test' },
    );
    await adapter.pushPrices([{ externalId: '1', sku: 'S', price: 10 }]);
    expect(calls[0].url).toBe('https://fake-prices.test/api/v2/upload/task');
  });

  it('WB pushPrices: нечисловой externalId → errors, позиция пропущена', async () => {
    const { fetchImpl, calls } = makeFakeFetch([{ ok: true, status: 200 }]);
    const adapter = new WbAdapter(
      { platform: 'wb', apiKey: 'T', externalWarehouseId: '1' },
      { fetchImpl },
    );
    const res = await adapter.pushPrices([
      { externalId: 'NOT_A_NUMBER', sku: 'S1', price: 10 },
      { externalId: '42', sku: 'S2', price: 20 },
    ]);
    // Валидная позиция отправлена, невалидная — в errors.
    expect(res.ok).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('NOT_A_NUMBER');
    expect(calls[0].body).toEqual({ data: [{ nmID: 42, price: 20 }] });
  });

  it('WB pushPrices: HTTP-ошибка → errors', async () => {
    const { fetchImpl } = makeFakeFetch([{ ok: false, status: 400, text: 'bad nmID' }]);
    const adapter = new WbAdapter(
      { platform: 'wb', apiKey: 'T', externalWarehouseId: '1' },
      { fetchImpl },
    );
    const res = await adapter.pushPrices([{ externalId: '42', sku: 'S', price: 10 }]);
    expect(res.ok).toBe(0);
    expect(res.errors[0]).toContain('HTTP 400');
  });

  it('Ozon fetchNewOrders: пагинация — 2 страницы (100+30) → 130 заказов', async () => {
    // Страница 1 — ровно 100 постингов (триггер следующей), страница 2 — 30.
    const page = (count: number, prefix: string) => ({
      ok: true,
      status: 200,
      json: {
        result: {
          postings: Array.from({ length: count }, (_, i) => ({
            posting_number: `${prefix}-${i}`,
            status: 'awaiting_packaging',
            products: [{ offer_id: 'OF', price: '1.00', quantity: 1 }],
          })),
        },
      },
    });
    const { fetchImpl, calls } = makeFakeFetch([page(100, 'A'), page(30, 'B')]);
    const adapter = new OzonAdapter({ platform: 'ozon', apiKey: 'K', clientId: 'C' }, { fetchImpl });
    const orders = await adapter.fetchNewOrders();
    expect(orders).toHaveLength(130);
    expect(calls).toHaveLength(2);
    // Второй запрос со смещением offset=100.
    expect((calls[1].body as { offset: number }).offset).toBe(100);
  });

  it('Ozon fetchNewOrders: неполная первая страница → одна итерация', async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      {
        ok: true,
        status: 200,
        json: {
          result: {
            postings: [
              { posting_number: 'P-1', status: 'new', products: [{ offer_id: 'O', price: '1', quantity: 1 }] },
            ],
          },
        },
      },
    ]);
    const adapter = new OzonAdapter({ platform: 'ozon', apiKey: 'K', clientId: 'C' }, { fetchImpl });
    const orders = await adapter.fetchNewOrders();
    expect(orders).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('ретрай: 429 затем 200 → успех после одного ретрая', async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      { ok: false, status: 429, text: 'rate limit' },
      { ok: true, status: 200 },
    ]);
    const adapter = new WbAdapter(
      { platform: 'wb', apiKey: 'T', externalWarehouseId: '1' },
      { fetchImpl, retry: { sleep: async () => {} } },
    );
    const res = await adapter.pushStocks([{ externalId: 'n', sku: 's', qty: 1 }]);
    expect(res).toEqual({ ok: 1, errors: [] });
    expect(calls).toHaveLength(2);
  });

  it('ретрай: постоянный 500 → ошибка после N попыток', async () => {
    const { fetchImpl, calls } = makeFakeFetch([{ ok: false, status: 500, text: 'oops' }]);
    const adapter = new OzonAdapter(
      { platform: 'ozon', apiKey: 'K', clientId: 'C' },
      { fetchImpl, retry: { maxAttempts: 3, sleep: async () => {} } },
    );
    const res = await adapter.pushPrices([{ externalId: 'O', sku: 'O', price: 10 }]);
    expect(res.ok).toBe(0);
    expect(res.errors[0]).toContain('HTTP 500');
    // 3 попытки выполнены.
    expect(calls).toHaveLength(3);
  });

  it('ретрай: 4xx (кроме 429) НЕ повторяется', async () => {
    const { fetchImpl, calls } = makeFakeFetch([{ ok: false, status: 400, text: 'bad' }]);
    const adapter = new OzonAdapter(
      { platform: 'ozon', apiKey: 'K', clientId: 'C' },
      { fetchImpl, retry: { maxAttempts: 3, sleep: async () => {} } },
    );
    const res = await adapter.pushPrices([{ externalId: 'O', sku: 'O', price: 10 }]);
    expect(res.errors[0]).toContain('HTTP 400');
    expect(calls).toHaveLength(1);
  });
});
