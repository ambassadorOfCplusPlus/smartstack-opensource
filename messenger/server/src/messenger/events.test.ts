import { describe, it, expect } from 'vitest';
import { EventHub, TicketStore, type RealtimeEvent } from './events';

describe('EventHub', () => {
  it('доставляет событие только подписанным участникам', () => {
    const hub = new EventHub();
    const a: RealtimeEvent[] = [];
    const b: RealtimeEvent[] = [];
    hub.subscribe('u1', (e) => a.push(e));
    hub.subscribe('u2', (e) => b.push(e));
    const n = hub.publish(['u1', 'u3'], { type: 'message', conversationId: 'c1', at: 1 });
    expect(n).toBe(1); // u1 доставлено, u3 не подписан, u2 не в списке
    expect(a).toHaveLength(1);
    expect(a[0]).toEqual({ type: 'message', conversationId: 'c1', at: 1 });
    expect(b).toHaveLength(0);
  });

  it('несколько подключений одного пользователя (вкладки/устройства) получают все', () => {
    const hub = new EventHub();
    let n1 = 0;
    let n2 = 0;
    hub.subscribe('u1', () => n1++);
    hub.subscribe('u1', () => n2++);
    expect(hub.connectionCount('u1')).toBe(2);
    hub.publish(['u1'], { type: 'message', conversationId: 'c', at: 0 });
    expect(n1).toBe(1);
    expect(n2).toBe(1);
  });

  it('дубли userId в рассылке не приводят к двойной доставке', () => {
    const hub = new EventHub();
    let cnt = 0;
    hub.subscribe('u1', () => cnt++);
    hub.publish(['u1', 'u1', 'u1'], { type: 'react', conversationId: 'c', at: 0 });
    expect(cnt).toBe(1);
  });

  it('отписка прекращает доставку и чистит пустые наборы', () => {
    const hub = new EventHub();
    let cnt = 0;
    const off = hub.subscribe('u1', () => cnt++);
    off();
    expect(hub.connectionCount('u1')).toBe(0);
    hub.publish(['u1'], { type: 'message', conversationId: 'c', at: 0 });
    expect(cnt).toBe(0);
  });

  it('исключение в одном слушателе не валит рассылку другим', () => {
    const hub = new EventHub();
    let ok = 0;
    hub.subscribe('u1', () => {
      throw new Error('bad listener');
    });
    hub.subscribe('u1', () => ok++);
    const n = hub.publish(['u1'], { type: 'message', conversationId: 'c', at: 0 });
    expect(ok).toBe(1);
    expect(n).toBe(1); // битый слушатель не засчитан, второй доставлен
  });
});

describe('TicketStore', () => {
  it('одноразовый: второй consume того же тикета — null', () => {
    let t = 1000;
    let seq = 0;
    const store = new TicketStore(30_000, () => t, () => `tk${++seq}`);
    const ticket = store.create('u1');
    expect(store.consume(ticket)).toBe('u1');
    expect(store.consume(ticket)).toBeNull(); // single-use
  });

  it('истёкший тикет не принимается', () => {
    let t = 0;
    const store = new TicketStore(1000, () => t);
    const ticket = store.create('u1');
    t = 1001; // прошло больше TTL
    expect(store.consume(ticket)).toBeNull();
  });

  it('действительный тикет в пределах TTL возвращает userId', () => {
    let t = 0;
    const store = new TicketStore(1000, () => t);
    const ticket = store.create('u9');
    t = 999;
    expect(store.consume(ticket)).toBe('u9');
  });

  it('неизвестный/пустой тикет — null', () => {
    const store = new TicketStore();
    expect(store.consume('nope')).toBeNull();
    expect(store.consume('')).toBeNull();
  });

  it('тикеты привязаны к своему пользователю', () => {
    let seq = 0;
    const store = new TicketStore(30_000, () => 0, () => `tk${++seq}`);
    const t1 = store.create('alice');
    const t2 = store.create('bob');
    expect(store.consume(t2)).toBe('bob');
    expect(store.consume(t1)).toBe('alice');
  });
});
