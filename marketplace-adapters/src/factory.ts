// Фабрика адаптеров: по аккаунту возвращает нужную реализацию (WB/Ozon).
// fetch инжектируется (default — глобальный fetch Node), чтобы тесты подменяли его.

import type { AdapterAccount, FetchLike, MarketplaceAdapter } from './types';
import { WbAdapter } from './wb.adapter';
import { OzonAdapter } from './ozon.adapter';
import { YandexAdapter } from './yandex.adapter';
import { SberAdapter } from './sber.adapter';

// Глобальный fetch Node как FetchLike (структурно совместим).
const defaultFetch: FetchLike = (input, init) =>
  fetch(input, init) as unknown as ReturnType<FetchLike>;

export function adapterFor(
  account: AdapterAccount,
  fetchImpl: FetchLike = defaultFetch,
): MarketplaceAdapter {
  switch (account.platform) {
    case 'wb':
      return new WbAdapter(account, { fetchImpl });
    case 'ozon':
      return new OzonAdapter(account, { fetchImpl });
    case 'yandex':
      return new YandexAdapter(account, { fetchImpl });
    case 'sber':
      return new SberAdapter(account, { fetchImpl });
    default: {
      // Исчерпывающая проверка: при добавлении площадки TS заставит обработать.
      const _exhaustive: never = account.platform;
      throw new Error(`Неизвестная площадка: ${String(_exhaustive)}`);
    }
  }
}
