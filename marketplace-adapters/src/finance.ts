// Импорт финансов маркетплейса (Wildberries / Ozon) → унифицированные финстроки.
//
// Портировано 1:1 с C++ MarketplaceClient (SmartStock ERP,
// src/core/integration/MarketplaceClient.cpp): чистые парсеры финотчёта площадки
// в единый список операций для занесения в реестр «Финансы». Каждая операция →
// ОДНА строка по знаку суммы и типу операции (без двойного счёта); штраф/
// логистика/комиссия/возврат/хранение идут отдельными категориями.
//
// Идемпотентность импорта держится на externalId:
//   WB   — 'wb:' + rrd_id, а при пустом rrd_id — КОНТЕНТНЫЙ ключ
//          (дата|штрихкод|операция [+ |копейки]), иначе все безыдентификаторные
//          строки схлопнулись бы в один doc_ref и потерялись при дедупе.
//   Ozon — 'ozon:' + operation_id, при пустом/'0' — контентный ключ.
//
// Парсеры — ЧИСТЫЕ функции (тестируются без сети). Сетевые методы — на адаптерах
// (WbAdapter.fetchFinanceLines / OzonAdapter.fetchFinanceLines).

// Нормализованная категория финансовой операции (в реестр «Финансы»).
export type FinanceCategory =
  | 'Продажа'
  | 'Возврат'
  | 'Штраф'
  | 'Комиссия'
  | 'Логистика'
  | 'Хранение'
  | 'Приёмка'
  | 'Удержание'
  | 'Прочее';

// Унифицированная финансовая операция площадки.
export interface FinanceLine {
  // rrd_id (WB) / operation_id (Ozon) с префиксом площадки — для идемпотентности.
  externalId: string;
  // Дата операции, Unix epoch (UTC, в секундах). 0 — если дата не распознана.
  ts: number;
  // 'in' — поступление продавцу; 'out' — удержание/расход.
  direction: 'in' | 'out';
  // Абсолютная сумма в рублях (> 0).
  amount: number;
  // Нормализованная категория операции.
  category: FinanceCategory;
  // Тип операции площадки + sku/посылка (человекочитаемое примечание).
  note: string;
}

// ───────────────────────────── JSON-хелперы ─────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Число из JSON-значения, которое может прийти числом или строкой ("1490").
function jnum(v: unknown, def = 0): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isNaN(n) ? def : n;
  }
  return def;
}

// Строка из JSON-значения (число → текст; строка → как есть; иначе "").
function jstr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

// Строковое поле объекта с дефолтом, ТОЛЬКО если значение — строка (иначе def).
function strOr(o: Record<string, unknown>, key: string, def: string): string {
  const v = o[key];
  return typeof v === 'string' ? v : def;
}

// ───────────────────────────── Дата/число хелперы ───────────────────────────

// Дней с 1970-01-01 по григорианской дате (алгоритм H. Hinnant) — для перевода
// строки даты площадки в Unix-epoch UTC без локального mktime.
export function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400; // [0, 399]
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

// "YYYY-MM-DD[ HH:MM:SS]" или ISO "YYYY-MM-DDTHH:MM:SS..." → Unix epoch (UTC).
// Терпимо к разделителям (' '/'T') и отсутствию времени. 0 — если не распознано.
export function parseDateToEpochUtc(s: string): number {
  if (!s) return 0;
  const md = /^(\d+)-(\d+)-(\d+)/.exec(s);
  if (!md) return 0;
  const y = Number(md[1]);
  const mo = Number(md[2]);
  const d = Number(md[3]);
  let hh = 0;
  let mi = 0;
  let ss = 0;
  if (s.length > 10) {
    // %*c%d:%d:%d — пропустить разделитель (' '/'T'), затем H:M:S.
    const mt = /^.(\d+):(\d+):(\d+)/.exec(s.slice(10));
    if (mt) {
      hh = Number(mt[1]);
      mi = Number(mt[2]);
      ss = Number(mt[3]);
    }
  }
  if (y < 1970 || mo < 1 || mo > 12 || d < 1 || d > 31) return 0;
  const days = daysFromCivil(y, mo, d);
  return days * 86400 + hh * 3600 + mi * 60 + ss;
}

// Содержит ли строка подстроку (как C++ ci — обычный поиск, регистрозависимый;
// нормализаторы передают нужный регистр явно).
function ci(h: string, needle: string): boolean {
  return h.includes(needle);
}

// llround: округление к ближайшему, половина — ОТ нуля (как std::llround).
function llround(x: number): number {
  return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
}

// Сумма в копейках строкой — для КОНТЕНТНОГО ключа идемпотентности, когда у строки
// нет родного id площадки (rrd_id/operation_id). Детерминирована по содержимому.
function cents(v: number): string {
  return String(llround(v * 100));
}

// ───────────────────────────── Категории ────────────────────────────────────

// Нормализация типа операции WB (supplier_oper_name) → категория.
function normWbCategory(oper: string, pay: number): FinanceCategory {
  if (ci(oper, 'Штраф')) return 'Штраф';
  if (ci(oper, 'Логист')) return 'Логистика';
  if (ci(oper, 'Хранен')) return 'Хранение';
  if (ci(oper, 'Комисс')) return 'Комиссия';
  if (ci(oper, 'Возврат')) return 'Возврат';
  if (ci(oper, 'Продаж') || ci(oper, 'Реализ')) return 'Продажа';
  if (ci(oper, 'Удержан')) return 'Удержание';
  return pay >= 0 ? 'Продажа' : 'Прочее';
}

// Нормализация типа операции Ozon (operation_type_name + operation_type).
function normOzonCategory(name: string, type: string, amt: number): FinanceCategory {
  if (ci(name, 'штраф') || ci(name, 'Штраф')) return 'Штраф';
  if (ci(name, 'озврат') || type === 'returns') return 'Возврат';
  if (ci(name, 'огист') || ci(name, 'оставк')) return 'Логистика';
  if (ci(name, 'ранени')) return 'Хранение';
  if (ci(name, 'омисси') || type === 'services') return 'Комиссия';
  if (type === 'orders' || ci(name, 'родаж') || ci(name, 'еализац')) return 'Продажа';
  return amt >= 0 ? 'Продажа' : 'Прочее';
}

// ───────────────────────────── JSON-парсеры ─────────────────────────────────

// WB: ответ Statistics API reportDetailByPeriod — массив строк отчёта о
// реализации (поддерживаем и обёртку {data:[...]}). Каждая строка → одна
// FinanceLine (ppvz_for_pay по знаку), строки-удержания без выплаты разносятся.
export function parseWbFinanceReport(j: unknown): FinanceLine[] {
  const out: FinanceLine[] = [];
  let arr: unknown[] | null = null;
  if (Array.isArray(j)) arr = j;
  else if (isObj(j) && Array.isArray(j.data)) arr = j.data;
  if (!arr) return out;

  for (const r of arr) {
    if (!isObj(r)) continue;
    const rrd = 'rrd_id' in r ? jstr(r.rrd_id) : '';
    // Дата операции: rr_dt | rr_date | order_dt | sale_dt | dt | date.
    let dt = '';
    for (const k of ['rr_dt', 'rr_date', 'order_dt', 'sale_dt', 'dt', 'date']) {
      const v = r[k];
      if (typeof v === 'string' && v !== '') {
        dt = v;
        break;
      }
    }
    const ts = parseDateToEpochUtc(dt);
    const oper = strOr(r, 'supplier_oper_name', '');
    let sku = strOr(r, 'barcode', '');
    if (sku === '') sku = strOr(r, 'sa_name', '');
    const note = (cat: string): string => {
      let n = oper === '' ? cat : oper;
      if (sku !== '') n += ' · ' + sku;
      return n;
    };
    // Базовый ключ идемпотентности: обычно rrd_id; при его отсутствии — контентный
    // ключ (дата|штрихкод|операция), иначе безыдентификаторные строки схлопнутся.
    const rrdKey = rrd === '' ? `${dt}|${sku}|${oper}` : rrd;
    const pay = 'ppvz_for_pay' in r ? jnum(r.ppvz_for_pay) : 0;
    if (Math.abs(pay) >= 0.005) {
      // Основная строка реализации/возврата: к перечислению продавцу (по знаку).
      const category = normWbCategory(oper, pay);
      out.push({
        externalId: 'wb:' + rrdKey + (rrd === '' ? '|' + cents(pay) : ''),
        ts,
        amount: Math.abs(pay),
        direction: pay < 0 ? 'out' : 'in',
        category,
        note: note(category),
      });
      continue;
    }
    // Строка-удержание без выплаты: разносим ненулевые удержания отдельными строками.
    const ded: { v: number; cat: FinanceCategory }[] = [
      { v: 'penalty' in r ? jnum(r.penalty) : 0, cat: 'Штраф' },
      { v: 'delivery_rub' in r ? jnum(r.delivery_rub) : 0, cat: 'Логистика' },
      { v: 'storage_fee' in r ? jnum(r.storage_fee) : 0, cat: 'Хранение' },
      { v: 'acceptance' in r ? jnum(r.acceptance) : 0, cat: 'Приёмка' },
      { v: 'deduction' in r ? jnum(r.deduction) : 0, cat: 'Удержание' },
    ];
    for (const dd of ded) {
      if (Math.abs(dd.v) < 0.005) continue;
      // ':<категория>' разводит несколько удержаний одной строки; при пустом rrd_id
      // добавляем сумму, чтобы разные удержания не схлопывались.
      out.push({
        externalId: 'wb:' + rrdKey + ':' + dd.cat + (rrd === '' ? '|' + cents(dd.v) : ''),
        ts,
        amount: Math.abs(dd.v),
        direction: 'out',
        category: dd.cat,
        note: note(dd.cat),
      });
    }
  }
  return out;
}

// Ozon: тело запроса /v3/finance/transaction/list за период (постранично).
export function buildOzonFinanceRequest(
  dateFrom: string,
  dateTo: string,
  page: number,
  pageSize: number,
): {
  filter: {
    date: { from: string; to: string };
    operation_type: string[];
    posting_number: string;
    transaction_type: string;
  };
  page: number;
  page_size: number;
} {
  return {
    filter: {
      date: { from: dateFrom + 'T00:00:00.000Z', to: dateTo + 'T23:59:59.999Z' },
      operation_type: [],
      posting_number: '',
      transaction_type: 'all',
    },
    page,
    page_size: pageSize,
  };
}

// Ozon: ответ той же ручки → FinanceLine (operation_id, operation_date, amount,
// operation_type[_name]).
export function parseOzonFinanceTxns(j: unknown): FinanceLine[] {
  const out: FinanceLine[] = [];
  if (!isObj(j) || !isObj(j.result)) return out;
  const res = j.result;
  if (!Array.isArray(res.operations)) return out;
  for (const o of res.operations) {
    if (!isObj(o)) continue;
    const amt = 'amount' in o ? jnum(o.amount) : 0;
    if (Math.abs(amt) < 0.005) continue;
    const opId = 'operation_id' in o ? jstr(o.operation_id) : '';
    const dateStr = strOr(o, 'operation_date', '');
    const typeName = strOr(o, 'operation_type_name', '');
    const type = strOr(o, 'operation_type', '');
    let post = '';
    if (isObj(o.posting)) post = strOr(o.posting, 'posting_number', '');
    // operation_id обычно ненулевой; при отсутствии (или '0') берём контентный ключ.
    const noId = opId === '' || opId === '0';
    out.push({
      externalId: noId
        ? `ozon:${dateStr}|${type}|${post}|${cents(amt)}`
        : 'ozon:' + opId,
      ts: parseDateToEpochUtc(dateStr),
      amount: Math.abs(amt),
      direction: amt < 0 ? 'out' : 'in',
      category: normOzonCategory(typeName, type, amt),
      note: (typeName === '' ? type : typeName) + (post === '' ? '' : ' · ' + post),
    });
  }
  return out;
}

// ──────────────── Финотчёт из ФАЙЛА (кабинет, без API) — хелперы ──────────────

// Нормализация заголовка: нижний регистр (вкл. кириллицу), без пробелов/пунктуации.
function normHdr(raw: string): string {
  const strip = ' ._-\t"(),/';
  let out = '';
  for (const ch of raw.toLowerCase()) {
    if (strip.includes(ch)) continue;
    out += ch;
  }
  return out;
}

// Заголовок начинается с одного из синонимов (после нормализации обоих).
function findCol(hdr: string[], syns: string[]): number {
  for (let i = 0; i < hdr.length; i += 1) {
    const h = normHdr(hdr[i]);
    for (const s of syns) {
      if (h !== '' && h.startsWith(s)) return i; // «начинается с»
    }
  }
  return -1;
}

// Сумма из строки кабинета: пробелы/NBSP-разряды убрать, запятая → точка.
function numRu(s: string): number {
  let t = '';
  for (const c of s) {
    if (c === ' ' || c === '\t' || c === ' ') continue; // пробел/таб/NBSP
    if (c === ',') {
      t += '.';
      continue;
    }
    t += c;
  }
  if (t === '') return 0;
  const n = Number(t);
  return Number.isNaN(n) ? 0 : n;
}

// «ДД.ММ.ГГГГ[ ...]» → «ГГГГ-ММ-ДД»; ISO/прочее — как есть (разберёт parseDateToEpochUtc).
function normDateRu(s: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (y > 1900 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const p2 = (n: number): string => String(n).padStart(2, '0');
      return `${String(y).padStart(4, '0')}-${p2(mo)}-${p2(d)}`;
    }
  }
  return s;
}

function cellAt(row: string[], c: number): string {
  return c >= 0 && c < row.length ? row[c] : '';
}

// WB: таблица строк отчёта кабинета (table[0] = заголовки) → FinanceLine[].
// Колонки сопоставляются по русским заголовкам; суммы/даты — в формате кабинета.
// Строки приводятся к виду ответа API и разбираются parseWbFinanceReport.
export function parseWbFinanceTable(table: string[][]): FinanceLine[] {
  if (table.length < 2) return [];
  const hdr = table[0];
  const cOper = findCol(hdr, ['обоснованиедляоплаты', 'обоснование', 'типдокумента']);
  const cSku = findCol(hdr, ['баркод', 'штрихкод', 'barcode']);
  let cDate = findCol(hdr, ['датапродажи']); // приоритет — дата реализации
  if (cDate < 0) cDate = findCol(hdr, ['датазаказа', 'датаоперации', 'дата']);
  const cPay = findCol(hdr, ['кперечислениюпродавцу', 'кперечислению']);
  const cPenalty = findCol(hdr, ['общаясуммаштрафов', 'штраф']);
  const cDeliv = findCol(hdr, [
    'услугиподоставкетоварапокупателю',
    'услугиподоставке',
    'стоимостьлогистики',
    'логистика',
  ]);
  const cStorage = findCol(hdr, ['стоимостьхранения', 'хранение']);
  const cAccept = findCol(hdr, ['платнаяприёмка', 'платнаяприемка', 'приёмка', 'приемка']);
  const cDeduct = findCol(hdr, ['прочиеудержания', 'удержания']);

  const arr: Record<string, unknown>[] = [];
  for (let r = 1; r < table.length; r += 1) {
    const row = table[r];
    const o: Record<string, unknown> = {};
    if (cOper >= 0) o.supplier_oper_name = cellAt(row, cOper);
    if (cSku >= 0) o.barcode = cellAt(row, cSku);
    if (cDate >= 0) o.rr_dt = normDateRu(cellAt(row, cDate));
    if (cPay >= 0) o.ppvz_for_pay = numRu(cellAt(row, cPay));
    if (cPenalty >= 0) o.penalty = numRu(cellAt(row, cPenalty));
    if (cDeliv >= 0) o.delivery_rub = numRu(cellAt(row, cDeliv));
    if (cStorage >= 0) o.storage_fee = numRu(cellAt(row, cStorage));
    if (cAccept >= 0) o.acceptance = numRu(cellAt(row, cAccept));
    if (cDeduct >= 0) o.deduction = numRu(cellAt(row, cDeduct));
    arr.push(o);
  }
  return parseWbFinanceReport(arr); // переиспользуем категории/знак/идемпотентность
}

// Ozon: таблица строк отчёта кабинета (Финансы → Начисления) → FinanceLine[].
export function parseOzonFinanceTable(table: string[][]): FinanceLine[] {
  if (table.length < 2) return [];
  const hdr = table[0];
  let cDate = findCol(hdr, ['датаначисления']);
  if (cDate < 0) cDate = findCol(hdr, ['датаоперации', 'дата']);
  const cType = findCol(hdr, ['типначисления', 'типоперации', 'наименованиеоперации']);
  const cAmount = findCol(hdr, ['итого', 'суммаитого']); // «Итого»/«Итого, руб»/«Сумма итого»
  const cPost = findCol(hdr, ['номеротправления', 'отправление', 'номерзаказа']);

  const ops: Record<string, unknown>[] = [];
  for (let r = 1; r < table.length; r += 1) {
    const row = table[r];
    const o: Record<string, unknown> = {};
    if (cDate >= 0) o.operation_date = normDateRu(cellAt(row, cDate));
    if (cType >= 0) o.operation_type_name = cellAt(row, cType);
    if (cAmount >= 0) o.amount = numRu(cellAt(row, cAmount));
    if (cPost >= 0) o.posting = { posting_number: cellAt(row, cPost) };
    ops.push(o);
  }
  return parseOzonFinanceTxns({ result: { operations: ops } });
}

// Целое из JSON-значения числа/строки (для курсора rrdid WB). 0 — если не разобрано.
export function jllInt(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}
