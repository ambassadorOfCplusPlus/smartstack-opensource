import { describe, it, expect } from 'vitest';
import { InMemoryJournal, type SyncOperation } from './journal';

function op(id: string, deviceId: string, extra: Partial<SyncOperation> = {}): SyncOperation {
  return {
    id,
    deviceId,
    entityType: 'product',
    entityId: 'p1',
    operation: 'product_update',
    payload: { field: 'price', value: 80 },
    vectorClock: { [deviceId]: 1 },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('InMemoryJournal: монотонный serverSeq', () => {
  it('присваивает возрастающие serverSeq новым операциям', () => {
    const j = new InMemoryJournal();
    const r1 = j.append(op('id-1', 'A'), 'accepted');
    const r2 = j.append(op('id-2', 'A'), 'accepted');
    const r3 = j.append(op('id-3', 'B'), 'accepted');
    expect(r1.entry.serverSeq).toBe(1n);
    expect(r2.entry.serverSeq).toBe(2n);
    expect(r3.entry.serverSeq).toBe(3n);
    expect(j.maxSeq()).toBe(3n);
  });
});

describe('InMemoryJournal: идемпотентность по UUID', () => {
  it('повторный append той же операции → тот же serverSeq, duplicate=true, не применяется заново', () => {
    const j = new InMemoryJournal();
    const first = j.append(op('dup', 'A'), 'accepted');
    expect(first.duplicate).toBe(false);
    expect(first.entry.serverSeq).toBe(1n);

    // Ретрай той же операции (потеря ответа на устройстве).
    const retry = j.append(op('dup', 'A'), 'accepted');
    expect(retry.duplicate).toBe(true);
    expect(retry.entry.serverSeq).toBe(1n); // ТОТ ЖЕ seq
    expect(j.maxSeq()).toBe(1n); // seq НЕ вырос — применилось ровно один раз
  });

  it('повтор возвращает ИСХОДНЫЙ статус, даже если повторно прислан с другим статусом', () => {
    const j = new InMemoryJournal();
    j.append(op('x', 'A'), 'conflict');
    const retry = j.append(op('x', 'A'), 'accepted');
    expect(retry.duplicate).toBe(true);
    expect(retry.entry.status).toBe('conflict'); // сохранён первый статус
  });

  it('разные id применяются независимо', () => {
    const j = new InMemoryJournal();
    j.append(op('a', 'A'), 'accepted');
    j.append(op('b', 'A'), 'accepted');
    expect(j.maxSeq()).toBe(2n);
    expect(j.get('a')?.serverSeq).toBe(1n);
    expect(j.get('b')?.serverSeq).toBe(2n);
  });
});

describe('InMemoryJournal: pull (курсор serverSeq > since)', () => {
  it('отдаёт чужие accepted-операции по возрастанию serverSeq', () => {
    const j = new InMemoryJournal();
    j.append(op('a1', 'A'), 'accepted'); // seq 1
    j.append(op('b1', 'B'), 'accepted'); // seq 2
    j.append(op('a2', 'A'), 'accepted'); // seq 3

    // Устройство B тянет с since=0 — должно получить только операции A.
    const forB = j.pull('B', 0n, 100);
    expect(forB.map((e) => e.id)).toEqual(['a1', 'a2']);
    expect(forB.map((e) => e.serverSeq)).toEqual([1n, 3n]);
  });

  it('не отдаёт собственные операции устройства', () => {
    const j = new InMemoryJournal();
    j.append(op('a1', 'A'), 'accepted');
    expect(j.pull('A', 0n, 100)).toEqual([]);
  });

  it('не реплицирует conflict/rejected операции', () => {
    const j = new InMemoryJournal();
    j.append(op('c', 'A'), 'conflict');
    j.append(op('r', 'A'), 'rejected');
    j.append(op('ok', 'A'), 'accepted');
    expect(j.pull('B', 0n, 100).map((e) => e.id)).toEqual(['ok']);
  });

  it('since двигает курсор — повторный pull не отдаёт уже виденное', () => {
    const j = new InMemoryJournal();
    j.append(op('a1', 'A'), 'accepted'); // 1
    j.append(op('a2', 'A'), 'accepted'); // 2
    const page1 = j.pull('B', 0n, 100);
    const lastSeq = page1[page1.length - 1].serverSeq;
    j.append(op('a3', 'A'), 'accepted'); // 3
    const page2 = j.pull('B', lastSeq, 100);
    expect(page2.map((e) => e.id)).toEqual(['a3']);
  });

  it('limit ограничивает размер страницы', () => {
    const j = new InMemoryJournal();
    j.append(op('a1', 'A'), 'accepted');
    j.append(op('a2', 'A'), 'accepted');
    j.append(op('a3', 'A'), 'accepted');
    expect(j.pull('B', 0n, 2).map((e) => e.id)).toEqual(['a1', 'a2']);
  });
});
