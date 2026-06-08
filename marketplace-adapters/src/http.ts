// Общий HTTP-хелпер адаптеров маркетплейсов: ретрай на временные ошибки
// (HTTP 429 и 5xx), до 3 попыток с небольшим бэкоффом. 4xx (кроме 429) не
// ретраятся. Задержка инжектируема (sleep) — в тестах нулевая, не зависит от
// времени. Сетевой сбой fetch пробрасывается наружу (адаптер сам решает,
// что с ним делать), но между попытками тоже учитывается.

import type { FetchLike } from './types';

// Ответ fetch (структурно совместим с FetchLike).
type FetchResponse = Awaited<ReturnType<FetchLike>>;

export interface RetryOptions {
  // Максимум попыток (включая первую). По умолчанию 3.
  maxAttempts?: number;
  // Базовая задержка бэкоффа в мс (множится на номер попытки). По умолчанию 100.
  backoffBaseMs?: number;
  // Инжектируемая задержка (в тестах — нулевая/мгновенная).
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// true, если ответ стоит повторить (429 Too Many Requests или 5xx).
function isRetriableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

// Выполнить запрос с ретраем на 429/5xx. Сетевые ошибки fetch также
// ретраятся (до исчерпания попыток), затем пробрасываются. Возвращает
// последний полученный ответ (в т.ч. неуспешный — решение принимает адаптер).
export async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1],
  opts?: RetryOptions,
): Promise<FetchResponse> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const backoffBaseMs = opts?.backoffBaseMs ?? 100;
  const sleep = opts?.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res: FetchResponse;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      // Сетевой сбой: ретраим, на последней попытке пробрасываем.
      lastError = err;
      if (attempt < maxAttempts) {
        await sleep(backoffBaseMs * attempt);
        continue;
      }
      throw err;
    }
    // Успех или неретраиваемый код (включая 4xx кроме 429) — отдаём как есть.
    if (res.ok || !isRetriableStatus(res.status) || attempt === maxAttempts) {
      return res;
    }
    // Временная ошибка — ждём и повторяем.
    await sleep(backoffBaseMs * attempt);
  }
  // Недостижимо: цикл всегда вернёт или бросит. Подстраховка для типов.
  throw lastError ?? new Error('fetchWithRetry: исчерпаны попытки');
}

// Безопасно прочитать тело ответа (для текста ошибки), обрезав до 500 символов.
// Общий помощник адаптеров (WB/Ozon) — без дублирования.
export async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

// Текст ошибки из unknown (Error.message или String).
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
