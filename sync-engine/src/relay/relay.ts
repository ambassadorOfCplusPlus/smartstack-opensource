// Протокол облака-реле — ТЕКУЩИЙ стек оригинала SmartStock.
//
// Портирован по семантике из десктопа:
//   include/core/sync/RelayProtocol.hpp + include/core/sync/RelayClient.hpp.
//
// Реле — тупой append-only журнал зашифрованных кадров под «боксом» (топиком).
// Оно видит ТОЛЬКО шифротекст (ct) — без E2E-ключа содержимое не прочитать.
//   POST {base}/v1/box/{boxId}          {ts,device,ct,kind?}  → {"id":<int>}
//   GET  {base}/v1/box/{boxId}?since=<ts>&limit=<n>           → {"entries":[…]}
// Все запросы — с заголовком Authorization: Bearer <token>. Опрос по ts
// (epoch-мс) с курсором; идемпотентность гарантируется op_id на уровне движка
// (SyncEngine), а не транспортом.
//
// Транспорт инжектируемый (FetchLike, как в marketplace-adapters) — тесты идут
// без сети через фейковый fetch.

// Настройки реле.
export interface RelayConfig {
  baseUrl: string; // адрес реле, напр. http://194.87.234.157:8787 (без хвостового /)
  token: string; // Bearer-токен реле (общий секрет деплоя)
  boxId: string; // непрозрачный id бокса (топик)
}

// Один кадр из журнала бокса.
export interface RelayEntry {
  ts: number; // метка времени записи (epoch-мс), курсор опроса
  device: string; // источник
  frameB64: string; // зашифрованный кадр (как пришёл с устройства)
  name: string; // id записи (целое строкой) — для удаления
  kind: string; // тип кадра ("snapshot" | "" = обычная операция)
}

// Тип fetch, инжектируемый в клиент (совместим с глобальным fetch и с
// FetchLike marketplace-adapters).
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

// ── Чистые построители URL/тел и парсер ответа (без сети) ─────────────────────
export const relayhttp = {
  // URL добавления кадра: {base}/v1/box/{boxId}. Метод POST.
  appendUrl(cfg: RelayConfig): string {
    return `${cfg.baseUrl}/v1/box/${encodeURIComponent(cfg.boxId)}`;
  },
  // Тело POST: {"ts",…,"device",…,"ct",…,"kind"?}. kind пустой — обычный кадр.
  appendBody(ts: number, device: string, frameB64: string, kind = ''): string {
    const body: Record<string, unknown> = { ts, device, ct: frameB64 };
    if (kind) body['kind'] = kind;
    return JSON.stringify(body);
  },
  // URL опроса: {base}/v1/box/{boxId}?since=<ts>&limit=<n>. Метод GET.
  pollUrl(cfg: RelayConfig, sinceMs: number, limit: number): string {
    return `${this.appendUrl(cfg)}?since=${sinceMs}&limit=${limit}`;
  },
  // Разобрать ответ {"entries":[{id,ts,device,ct,kind}]} в список кадров.
  parsePoll(json: string): RelayEntry[] {
    let root: unknown;
    try {
      root = JSON.parse(json);
    } catch {
      throw new Error('relay: некорректный JSON ответа');
    }
    const entries = (root as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) {
      throw new Error('relay: нет массива entries');
    }
    const out: RelayEntry[] = [];
    for (const el of entries) {
      if (typeof el !== 'object' || el === null) continue;
      const j = el as Record<string, unknown>;
      const ct = j['ct'];
      if (typeof ct !== 'string') continue; // без шифротекста запись бесполезна
      out.push({
        ts: typeof j['ts'] === 'number' ? (j['ts'] as number) : 0,
        device: typeof j['device'] === 'string' ? (j['device'] as string) : '',
        frameB64: ct,
        name: j['id'] !== undefined && j['id'] !== null ? String(j['id']) : '',
        kind: typeof j['kind'] === 'string' ? (j['kind'] as string) : '',
      });
    }
    return out;
  },
} as const;

// Абстракция реле — чтобы оркестратор тестировался на фейке без сети.
export interface IRelay {
  // Записать зашифрованный кадр в журнал бокса.
  append(ts: number, device: string, frameB64: string, kind?: string): Promise<void>;
  // Кадры с ts >= sinceMs (до limit). Курсор вызывающий двигает по max(ts).
  poll(sinceMs: number, limit: number): Promise<RelayEntry[]>;
}

// true, если ответ стоит повторить (429 или 5xx) — как в marketplace-adapters.
function isRetriableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RelayClientOptions {
  maxAttempts?: number; // максимум попыток (включая первую), по умолчанию 3
  backoffBaseMs?: number; // база бэкоффа (× номер попытки), по умолчанию 100
  sleep?: (ms: number) => Promise<void>; // инжектируемая задержка (в тестах мгновенная)
}

// HTTP-клиент реле поверх инжектируемого fetch. Блокирующие сетевые вызовы
// (в C++ звались из фонового потока); ретрай на 429/5xx. Реле получает только
// шифротекст кадра (E2E); ключ ему не передаётся.
export class HttpRelayClient implements IRelay {
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly cfg: RelayConfig,
    private readonly fetchImpl: FetchLike,
    opts?: RelayClientOptions,
  ) {
    this.maxAttempts = opts?.maxAttempts ?? 3;
    this.backoffBaseMs = opts?.backoffBaseMs ?? 100;
    this.sleep = opts?.sleep ?? defaultSleep;
  }

  private authHeaders(json: boolean): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.cfg.token}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private async request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let res;
      try {
        res = await this.fetchImpl(url, init);
      } catch (err) {
        lastError = err;
        if (attempt < this.maxAttempts) {
          await this.sleep(this.backoffBaseMs * attempt);
          continue;
        }
        throw err;
      }
      if (res.ok || !isRetriableStatus(res.status) || attempt === this.maxAttempts) {
        return res;
      }
      await this.sleep(this.backoffBaseMs * attempt);
    }
    throw lastError ?? new Error('relay: исчерпаны попытки');
  }

  async append(ts: number, device: string, frameB64: string, kind = ''): Promise<void> {
    const res = await this.request(relayhttp.appendUrl(this.cfg), {
      method: 'POST',
      headers: this.authHeaders(true),
      body: relayhttp.appendBody(ts, device, frameB64, kind),
    });
    if (!res.ok) {
      throw new Error(`relay.append: HTTP ${res.status}`);
    }
  }

  async poll(sinceMs: number, limit: number): Promise<RelayEntry[]> {
    const res = await this.request(relayhttp.pollUrl(this.cfg, sinceMs, limit), {
      method: 'GET',
      headers: this.authHeaders(false),
    });
    if (!res.ok) {
      throw new Error(`relay.poll: HTTP ${res.status}`);
    }
    return relayhttp.parsePoll(await res.text());
  }
}
