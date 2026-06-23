// Реал-тайм доставка мессенджера: внутрипроцессная шина событий + одноразовые
// тикеты для SSE. ПРИВАТНОСТЬ: событие НЕ несёт ни контента, ни автора — только
// { type, conversationId }. Подключённый участник получает «пинг» и сам тянет
// sealed-сообщения → sealed-sender и E2E полностью сохраняются (сервер и так знает
// состав диалога, чтобы раздавать ему sealed-сообщения; нового раскрытия нет).
//
// Одно-инстансная (в памяти процесса). Для нескольких реплик — Postgres
// LISTEN/NOTIFY или Redis pub/sub (см. README, раздел «Реал-тайм»).

import { randomBytes } from 'node:crypto';

export type RealtimeEvent =
  | { type: 'message'; conversationId: string; at: number }
  | { type: 'react'; conversationId: string; at: number };

export type EventListener = (ev: RealtimeEvent) => void;

// Шина: подписка по userId (несколько вкладок/устройств = несколько слушателей),
// рассылка набору участников. Слушатель-исключение не валит остальных.
export class EventHub {
  private subs = new Map<string, Set<EventListener>>();

  subscribe(userId: string, fn: EventListener): () => void {
    let set = this.subs.get(userId);
    if (!set) {
      set = new Set();
      this.subs.set(userId, set);
    }
    set.add(fn);
    return () => {
      const s = this.subs.get(userId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.subs.delete(userId);
    };
  }

  // Разослать событие набору пользователей (дубли id игнорируются). Возвращает
  // число успешно доставленных слушателям (для тестов/диагностики).
  publish(userIds: Iterable<string>, ev: RealtimeEvent): number {
    let delivered = 0;
    const seen = new Set<string>();
    for (const uid of userIds) {
      if (seen.has(uid)) continue;
      seen.add(uid);
      const set = this.subs.get(uid);
      if (!set) continue;
      for (const fn of set) {
        try {
          fn(ev);
          delivered++;
        } catch {
          /* один битый слушатель не должен ронять рассылку */
        }
      }
    }
    return delivered;
  }

  connectionCount(userId: string): number {
    return this.subs.get(userId)?.size ?? 0;
  }
}

// Одноразовые короткоживущие тикеты: EventSource умеет только GET и не шлёт
// заголовков, а токен мессенджера в URL попал бы в логи/историю. Клиент по своему
// токену (authed) запрашивает тикет, затем EventSource открывает ?ticket=…. Тикет
// расходуется один раз и быстро истекает.
export class TicketStore {
  private tickets = new Map<string, { userId: string; exp: number }>();

  constructor(
    private ttlMs: number = 30_000,
    private now: () => number = () => Date.now(),
    private gen: () => string = () => randomBytes(24).toString('base64url'),
  ) {}

  create(userId: string): string {
    this.sweep();
    const t = this.gen();
    this.tickets.set(t, { userId, exp: this.now() + this.ttlMs });
    return t;
  }

  // Возвращает userId и УДАЛЯЕТ тикет (single-use). null — нет/просрочен.
  consume(ticket: string): string | null {
    if (!ticket) return null;
    const e = this.tickets.get(ticket);
    if (!e) return null;
    this.tickets.delete(ticket);
    if (e.exp < this.now()) return null;
    return e.userId;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.tickets) if (v.exp < t) this.tickets.delete(k);
  }
}
