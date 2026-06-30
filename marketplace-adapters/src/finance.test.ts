// Тесты импорта финансов маркетплейса. Чистые парсеры — без сети; сетевые методы
// адаптеров — на фейк-fetch (как в adapters.test.ts). Семантика портирована 1:1 с
// C++ MarketplaceClient (SmartStock ERP).

import { describe, it, expect } from 'vitest';
import {
  parseWbFinanceReport,
  parseOzonFinanceTxns,
  parseWbFinanceTable,
  parseOzonFinanceTable,
  buildOzonFinanceRequest,
  parseDateToEpochUtc,
} from './finance';
import { WbAdapter } from './wb.adapter';
import { OzonAdapter } from './ozon.adapter';
import type { FetchLike } from './types';

// ── Фейк-fetch (как в adapters.test.ts) ──────────────────────────────────────
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
    if (r.throwNetwork) throw new Error('ECONNREFUSED');
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.json,
      text: async () => r.text ?? '',
    };
  };
  return { fetchImpl, calls };
}

const epoch = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / 1000;

describe('finance: parseDateToEpochUtc', () => {
  it('дата без времени → полночь UTC (совпадает с Date.UTC)', () => {
    expect(parseDateToEpochUtc('2026-06-05')).toBe(epoch(2026, 6, 5));
  });
  it('ISO с временем (T-разделитель)', () => {
    expect(parseDateToEpochUtc('2026-06-05T12:30:45')).toBe(epoch(2026, 6, 5) + 12 * 3600 + 30 * 60 + 45);
  });
  it('пробел-разделитель времени', () => {
    expect(parseDateToEpochUtc('2026-06-05 01:02:03')).toBe(epoch(2026, 6, 5) + 3723);
  });
  it('нераспознанное / до 1970 → 0', () => {
    expect(parseDateToEpochUtc('')).toBe(0);
    expect(parseDateToEpochUtc('не дата')).toBe(0);
    expect(parseDateToEpochUtc('1969-12-31')).toBe(0);
  });
});

describe('finance: parseWbFinanceReport', () => {
  it('основная строка реализации (ppvz_for_pay > 0) → direction=in, категория Продажа', () => {
    const lines = parseWbFinanceReport([
      {
        rrd_id: 1001,
        rr_dt: '2026-06-01',
        supplier_oper_name: 'Продажа',
        barcode: 'BAR-1',
        ppvz_for_pay: 1490.5,
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      externalId: 'wb:1001',
      ts: epoch(2026, 6, 1),
      direction: 'in',
      amount: 1490.5,
      category: 'Продажа',
      note: 'Продажа · BAR-1',
    });
  });

  it('возврат (ppvz_for_pay < 0) → direction=out, категория Возврат, amount по модулю', () => {
    const lines = parseWbFinanceReport([
      { rrd_id: 1002, rr_dt: '2026-06-02', supplier_oper_name: 'Возврат', barcode: 'BAR-2', ppvz_for_pay: -300 },
    ]);
    expect(lines[0].direction).toBe('out');
    expect(lines[0].category).toBe('Возврат');
    expect(lines[0].amount).toBe(300);
    expect(lines[0].externalId).toBe('wb:1002');
  });

  it('строка-удержание без выплаты → отдельные строки по ненулевым удержаниям', () => {
    const lines = parseWbFinanceReport([
      {
        rrd_id: 2001,
        rr_dt: '2026-06-03',
        supplier_oper_name: 'Логистика',
        barcode: 'BAR-3',
        ppvz_for_pay: 0,
        penalty: 50,
        delivery_rub: 120,
        storage_fee: 0, // нулевое — пропускается
        acceptance: 7,
        deduction: 0,
      },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.category)).toEqual(['Штраф', 'Логистика', 'Приёмка']);
    expect(lines.every((l) => l.direction === 'out')).toBe(true);
    expect(lines.map((l) => l.amount)).toEqual([50, 120, 7]);
    // Несколько удержаний одной строки разводятся суффиксом ':<категория>'.
    expect(lines[0].externalId).toBe('wb:2001:Штраф');
    expect(lines[1].externalId).toBe('wb:2001:Логистика');
  });

  it('порог 0.005: микро-сумма ppvz и микро-удержание игнорируются', () => {
    const lines = parseWbFinanceReport([
      { rrd_id: 3001, rr_dt: '2026-06-04', ppvz_for_pay: 0.004, penalty: 0.004 },
    ]);
    expect(lines).toHaveLength(0);
  });

  it('контентный ключ при пустом rrd_id — основная строка (дата|штрихкод|операция|копейки)', () => {
    const lines = parseWbFinanceReport([
      { rr_dt: '2026-06-05', supplier_oper_name: 'Продажа', barcode: 'BAR-9', ppvz_for_pay: 100.25 },
    ]);
    expect(lines[0].externalId).toBe('wb:2026-06-05|BAR-9|Продажа|10025');
  });

  it('контентный ключ при пустом rrd_id — удержание добавляет сумму, разные удержания не схлопываются', () => {
    const lines = parseWbFinanceReport([
      {
        rr_dt: '2026-06-06',
        supplier_oper_name: 'Хранение',
        barcode: 'BAR-10',
        ppvz_for_pay: 0,
        storage_fee: 80,
        penalty: 40,
      },
    ]);
    const ids = lines.map((l) => l.externalId);
    expect(ids).toContain('wb:2026-06-06|BAR-10|Хранение:Штраф|4000');
    expect(ids).toContain('wb:2026-06-06|BAR-10|Хранение:Хранение|8000');
    expect(new Set(ids).size).toBe(ids.length); // все ключи различны
  });

  it('обёртка {data:[...]} поддерживается', () => {
    const lines = parseWbFinanceReport({ data: [{ rrd_id: 5, rr_dt: '2026-06-01', ppvz_for_pay: 10 }] });
    expect(lines).toHaveLength(1);
    expect(lines[0].externalId).toBe('wb:5');
  });
});

describe('finance: parseOzonFinanceTxns', () => {
  it('операция с operation_id → ozon:<id>, знак суммы определяет direction', () => {
    const lines = parseOzonFinanceTxns({
      result: {
        operations: [
          {
            operation_id: 777,
            operation_date: '2026-06-01 10:00:00',
            operation_type: 'orders',
            operation_type_name: 'Заказ', // нейтральное имя → срабатывает type='orders'
            amount: 540,
            posting: { posting_number: 'P-1' },
          },
        ],
      },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].externalId).toBe('ozon:777');
    expect(lines[0].direction).toBe('in');
    expect(lines[0].category).toBe('Продажа'); // type='orders'
    expect(lines[0].note).toBe('Заказ · P-1');
    expect(lines[0].ts).toBe(epoch(2026, 6, 1) + 10 * 3600);
  });

  it('контентный ключ при отсутствии operation_id', () => {
    const lines = parseOzonFinanceTxns({
      result: {
        operations: [
          {
            operation_date: '2026-06-02',
            operation_type: 'services',
            operation_type_name: 'Комиссия',
            amount: -90.5,
            posting: { posting_number: 'P-2' },
          },
        ],
      },
    });
    expect(lines[0].externalId).toBe('ozon:2026-06-02|services|P-2|-9050');
    expect(lines[0].direction).toBe('out');
    expect(lines[0].category).toBe('Комиссия');
    expect(lines[0].amount).toBe(90.5);
  });

  it('operation_id="0" трактуется как отсутствие id (контентный ключ)', () => {
    const lines = parseOzonFinanceTxns({
      result: { operations: [{ operation_id: '0', operation_date: '2026-06-03', operation_type: 'returns', amount: -10 }] },
    });
    expect(lines[0].externalId).toBe('ozon:2026-06-03|returns||-1000');
    expect(lines[0].category).toBe('Возврат');
  });

  it('микро-сумма (< порога) пропускается; не-объекты в result игнорируются', () => {
    expect(parseOzonFinanceTxns({ result: { operations: [{ operation_id: 1, amount: 0.001 }] } })).toHaveLength(0);
    expect(parseOzonFinanceTxns({})).toHaveLength(0);
  });
});

describe('finance: нормализация категорий', () => {
  it('WB: тип операции → категория (приоритет штраф/логистика/хранение/комиссия)', () => {
    const cat = (oper: string, pay = 100): string =>
      parseWbFinanceReport([{ rrd_id: 1, rr_dt: '2026-06-01', supplier_oper_name: oper, ppvz_for_pay: pay }])[0]
        .category;
    expect(cat('Штраф за брак')).toBe('Штраф');
    expect(cat('Логистика')).toBe('Логистика');
    expect(cat('Хранение')).toBe('Хранение');
    expect(cat('Комиссия за продажу')).toBe('Комиссия');
    expect(cat('Реализация')).toBe('Продажа');
    expect(cat('Удержание')).toBe('Удержание');
    expect(cat('Неведомая операция', 100)).toBe('Продажа'); // pay>=0
    expect(cat('Неведомая операция', -100)).toBe('Прочее'); // pay<0
  });

  it('Ozon: тип операции → категория (по имени и по type)', () => {
    const cat = (name: string, type: string, amt = 100): string =>
      parseOzonFinanceTxns({
        result: { operations: [{ operation_id: 1, operation_date: '2026-06-01', operation_type: type, operation_type_name: name, amount: amt }] },
      })[0].category;
    expect(cat('Штраф', '')).toBe('Штраф');
    expect(cat('Возврат товара', '')).toBe('Возврат');
    expect(cat('', 'returns')).toBe('Возврат');
    expect(cat('Доставка', '')).toBe('Логистика');
    expect(cat('Хранение', '')).toBe('Хранение');
    expect(cat('', 'services')).toBe('Комиссия');
    expect(cat('', 'orders')).toBe('Продажа');
    expect(cat('что-то', 'other', 100)).toBe('Продажа');
    expect(cat('что-то', 'other', -100)).toBe('Прочее');
  });
});

describe('finance: parseWbFinanceTable (файл кабинета)', () => {
  it('русские заголовки, RU-числа/даты → те же финстроки', () => {
    const table = [
      ['Обоснование для оплаты', 'Баркод', 'Дата продажи', 'К перечислению продавцу', 'Общая сумма штрафов'],
      ['Продажа', 'BAR-1', '05.06.2026', '1 490,50', '0'],
      ['Логистика', 'BAR-2', '06.06.2026', '0', '120,00'],
    ];
    const lines = parseWbFinanceTable(table);
    // Строка 1 — продажа 1490,50; строка 2 — без выплаты, штраф 120.
    expect(lines).toHaveLength(2);
    expect(lines[0].category).toBe('Продажа');
    expect(lines[0].amount).toBe(1490.5);
    expect(lines[0].ts).toBe(epoch(2026, 6, 5));
    expect(lines[1].category).toBe('Штраф');
    expect(lines[1].amount).toBe(120);
    expect(lines[1].direction).toBe('out');
  });

  it('таблица без строк данных → пусто', () => {
    expect(parseWbFinanceTable([['Баркод']])).toEqual([]);
    expect(parseWbFinanceTable([])).toEqual([]);
  });
});

describe('finance: parseOzonFinanceTable (файл кабинета)', () => {
  it('русские заголовки «Дата начисления/Тип начисления/Итого/Номер отправления»', () => {
    const table = [
      ['Дата начисления', 'Тип начисления', 'Итого', 'Номер отправления'],
      ['01.06.2026', 'Доставка покупателю', '540,00', 'P-1'],
      ['02.06.2026', 'Комиссия', '-90,50', 'P-2'],
    ];
    const lines = parseOzonFinanceTable(table);
    expect(lines).toHaveLength(2);
    expect(lines[0].direction).toBe('in');
    expect(lines[0].amount).toBe(540);
    expect(lines[0].ts).toBe(epoch(2026, 6, 1));
    expect(lines[0].note).toContain('P-1');
    expect(lines[1].category).toBe('Комиссия');
    expect(lines[1].direction).toBe('out');
    expect(lines[1].amount).toBe(90.5);
  });
});

describe('finance: buildOzonFinanceRequest', () => {
  it('границы периода и постраничные поля', () => {
    expect(buildOzonFinanceRequest('2026-06-01', '2026-06-30', 2, 1000)).toEqual({
      filter: {
        date: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T23:59:59.999Z' },
        operation_type: [],
        posting_number: '',
        transaction_type: 'all',
      },
      page: 2,
      page_size: 1000,
    });
  });
});

describe('finance: WbAdapter.fetchFinanceLines (сеть)', () => {
  it('одна неполная страница → один запрос, токен из statsApiKey', async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      { ok: true, status: 200, json: [{ rrd_id: 1, rr_dt: '2026-06-01', supplier_oper_name: 'Продажа', barcode: 'B', ppvz_for_pay: 100 }] },
    ]);
    const adapter = new WbAdapter(
      { platform: 'wb', apiKey: 'MAIN', statsApiKey: 'STATS_TOKEN', externalWarehouseId: '1' },
      { fetchImpl },
    );
    const lines = await adapter.fetchFinanceLines('2026-06-01', '2026-06-30');
    expect(lines).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod');
    expect(calls[0].url).toContain('rrdid=0');
    expect(calls[0].headers?.Authorization).toBe('STATS_TOKEN'); // statsApiKey в приоритете
  });

  it('пустой ответ ([]) → стоп без строк; statsApiKey пуст → берётся apiKey', async () => {
    const { fetchImpl, calls } = makeFakeFetch([{ ok: true, status: 200, json: [] }]);
    const adapter = new WbAdapter({ platform: 'wb', apiKey: 'MAIN' }, { fetchImpl });
    const lines = await adapter.fetchFinanceLines('2026-06-01', '2026-06-30');
    expect(lines).toHaveLength(0);
    expect(calls[0].headers?.Authorization).toBe('MAIN');
  });

  it('HTTP-ошибка → бросает с текстом «WB финансы»', async () => {
    const { fetchImpl } = makeFakeFetch([{ ok: false, status: 401, text: 'unauthorized' }]);
    const adapter = new WbAdapter({ platform: 'wb', apiKey: 'T' }, { fetchImpl, retry: { sleep: async () => {} } });
    await expect(adapter.fetchFinanceLines('2026-06-01', '2026-06-30')).rejects.toThrow('WB финансы');
  });
});

describe('finance: OzonAdapter.fetchFinanceLines (сеть)', () => {
  it('пагинация по page_count: 2 страницы, верный URL/тело', async () => {
    const opPage = (id: number) => ({
      ok: true,
      status: 200,
      json: {
        result: {
          page_count: 2,
          operations: [{ operation_id: id, operation_date: '2026-06-01', operation_type: 'orders', amount: 100 }],
        },
      },
    });
    const { fetchImpl, calls } = makeFakeFetch([opPage(1), opPage(2)]);
    const adapter = new OzonAdapter({ platform: 'ozon', apiKey: 'K', clientId: 'C' }, { fetchImpl });
    const lines = await adapter.fetchFinanceLines('2026-06-01', '2026-06-30');
    expect(lines).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://api-seller.ozon.ru/v3/finance/transaction/list');
    expect((calls[0].body as { page: number }).page).toBe(1);
    expect((calls[1].body as { page: number }).page).toBe(2);
    expect(calls[0].headers?.['Client-Id']).toBe('C');
    expect(calls[0].headers?.['Api-Key']).toBe('K');
  });

  it('одна страница (page_count=1) → один запрос', async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      { ok: true, status: 200, json: { result: { page_count: 1, operations: [] } } },
    ]);
    const adapter = new OzonAdapter({ platform: 'ozon', apiKey: 'K', clientId: 'C' }, { fetchImpl });
    const lines = await adapter.fetchFinanceLines('2026-06-01', '2026-06-30');
    expect(lines).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('сетевой сбой → бросает «Ozon финансы»', async () => {
    const { fetchImpl } = makeFakeFetch([{ ok: false, status: 0, throwNetwork: true }]);
    const adapter = new OzonAdapter(
      { platform: 'ozon', apiKey: 'K', clientId: 'C' },
      { fetchImpl, retry: { sleep: async () => {} } },
    );
    await expect(adapter.fetchFinanceLines('2026-06-01', '2026-06-30')).rejects.toThrow('Ozon финансы');
  });
});
