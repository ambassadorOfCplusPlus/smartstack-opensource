import { describe, it, expect } from 'vitest';
import {
  classifyPhysical,
  classifySemantic,
  FieldVerdict,
  tallyVote,
  resolveByAdmin,
} from './conflict';

describe('classifyPhysical', () => {
  it('хватает остатка → applied, списываем всё', () => {
    expect(classifyPhysical({ requested: 30, available: 50 })).toEqual({
      kind: 'applied',
      writeoff: 30,
    });
  });

  it('ровно хватает → applied', () => {
    expect(classifyPhysical({ requested: 50, available: 50 })).toEqual({
      kind: 'applied',
      writeoff: 50,
    });
  });

  it('два офлайн-списания 30+30 при остатке 50 → второе физ. конфликт', () => {
    // Первое списание 30 проходит (осталось 20), второе видит available=20.
    const second = classifyPhysical({ requested: 30, available: 20 });
    expect(second).toEqual({
      kind: 'physical_conflict',
      writeoff: 20,
      shortage: 10, // недостача -10 → нужна инвентаризация
      available: 20,
    });
  });

  it('партии нет (available 0) → полная недостача', () => {
    expect(classifyPhysical({ requested: 5, available: 0 })).toEqual({
      kind: 'physical_conflict',
      writeoff: 0,
      shortage: 5,
      available: 0,
    });
  });

  it('отрицательный available трактуется как 0', () => {
    const out = classifyPhysical({ requested: 5, available: -3 });
    expect(out).toEqual({ kind: 'physical_conflict', writeoff: 0, shortage: 5, available: 0 });
  });
});

describe('classifySemantic (vector clocks)', () => {
  it('первая правка поля → apply', () => {
    expect(classifySemantic({ incoming: { A: 1 }, last: null })).toBe(FieldVerdict.Apply);
  });

  it('входящая — потомок последней → apply', () => {
    expect(classifySemantic({ incoming: { A: 2, B: 1 }, last: { A: 1, B: 1 } })).toBe(
      FieldVerdict.Apply,
    );
  });

  it('хранимая доминирует над входящей → stale', () => {
    expect(classifySemantic({ incoming: { A: 1, B: 1 }, last: { A: 2, B: 1 } })).toBe(
      FieldVerdict.Stale,
    );
  });

  it('конкуррентные правки (80₽ vs 85₽ офлайн) → concurrent → голосование', () => {
    // A правил цену офлайн (A:2,B:1), B правил офлайн (A:1,B:2) — друг о друге не знают.
    expect(classifySemantic({ incoming: { A: 2, B: 1 }, last: { A: 1, B: 2 } })).toBe(
      FieldVerdict.Concurrent,
    );
  });

  it('равные векторы → apply (не считается устаревшим/конфликтным)', () => {
    expect(classifySemantic({ incoming: { A: 1 }, last: { A: 1 } })).toBe(FieldVerdict.Apply);
  });
});

describe('tallyVote (авторазрешение по большинству)', () => {
  it('не все проголосовали → не разрешено', () => {
    expect(tallyVote({ a: 2, b: 0, eligible: 5, cast: 2 })).toEqual({ resolved: false });
  });

  it('полный кворум + перевес A → разрешено в пользу A', () => {
    expect(tallyVote({ a: 3, b: 2, eligible: 5, cast: 5 })).toEqual({
      resolved: true,
      winner: 'a',
      mode: 'majority',
    });
  });

  it('полный кворум + перевес B → разрешено в пользу B', () => {
    expect(tallyVote({ a: 1, b: 4, eligible: 5, cast: 5 })).toEqual({
      resolved: true,
      winner: 'b',
      mode: 'majority',
    });
  });

  it('полный кворум, но равенство → не разрешено (нужен админ)', () => {
    expect(tallyVote({ a: 2, b: 2, eligible: 4, cast: 4 })).toEqual({ resolved: false });
  });
});

describe('resolveByAdmin', () => {
  it('majority с перевесом → победитель по большинству', () => {
    expect(resolveByAdmin({ a: 3, b: 1 }, 'majority')).toEqual({ winner: 'a', mode: 'majority' });
  });

  it('majority при равенстве → ошибка (нужно вето)', () => {
    expect(() => resolveByAdmin({ a: 2, b: 2 }, 'majority')).toThrow(/Равенство/);
  });

  it('veto с выбором → выбор админа', () => {
    expect(resolveByAdmin({ a: 0, b: 5 }, 'veto', 'a')).toEqual({ winner: 'a', mode: 'veto' });
  });

  it('veto без выбора → ошибка', () => {
    expect(() => resolveByAdmin({ a: 1, b: 1 }, 'veto')).toThrow(/вето/);
  });
});
