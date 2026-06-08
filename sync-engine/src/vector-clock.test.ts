import { describe, it, expect } from 'vitest';
import { dominates, isConcurrent, increment, merge } from './vector-clock';

describe('vector-clock: dominates', () => {
  it('равные векторы доминируют друг над другом', () => {
    expect(dominates({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(dominates({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  });

  it('потомок доминирует над предком', () => {
    expect(dominates({ a: 2, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(dominates({ a: 1, b: 2 }, { a: 2, b: 2 })).toBe(false);
  });

  it('отсутствующая компонента трактуется как 0', () => {
    expect(dominates({ a: 1 }, {})).toBe(true);
    expect(dominates({}, { a: 1 })).toBe(false);
    expect(dominates({ a: 1, b: 0 }, { a: 1 })).toBe(true);
  });

  it('пустой вектор доминирует только над пустым/нулевым', () => {
    expect(dominates({}, {})).toBe(true);
    expect(dominates({}, { a: 0 })).toBe(true);
  });
});

describe('vector-clock: isConcurrent', () => {
  it('параллельные правки (никто не доминирует) конкуррентны', () => {
    // A знает про свою 2-ю операцию, B — про свою; друг о друге не знают.
    expect(isConcurrent({ A: 2, B: 1 }, { A: 1, B: 2 })).toBe(true);
  });

  it('причинно упорядоченные НЕ конкуррентны', () => {
    expect(isConcurrent({ a: 2, b: 2 }, { a: 1, b: 2 })).toBe(false);
    expect(isConcurrent({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(false); // равные
  });

  it('симметрична', () => {
    const x = { A: 3, B: 1 };
    const y = { A: 1, B: 5 };
    expect(isConcurrent(x, y)).toBe(isConcurrent(y, x));
    expect(isConcurrent(x, y)).toBe(true);
  });
});

describe('vector-clock: increment', () => {
  it('инкрементирует собственную компоненту, не мутируя вход', () => {
    const vc = { A: 1 };
    const next = increment(vc, 'A');
    expect(next).toEqual({ A: 2 });
    expect(vc).toEqual({ A: 1 }); // вход не тронут
  });

  it('заводит новую компоненту с 1', () => {
    expect(increment({}, 'B')).toEqual({ B: 1 });
    expect(increment({ A: 5 }, 'B')).toEqual({ A: 5, B: 1 });
  });

  it('инкремент делает вектор потомком исходного', () => {
    const vc = { A: 1, B: 2 };
    expect(dominates(increment(vc, 'A'), vc)).toBe(true);
  });
});

describe('vector-clock: merge', () => {
  it('берёт покомпонентный максимум', () => {
    expect(merge({ A: 2, B: 1 }, { A: 1, B: 5, C: 3 })).toEqual({ A: 2, B: 5, C: 3 });
  });

  it('не мутирует входы', () => {
    const a = { A: 1 };
    const b = { B: 2 };
    merge(a, b);
    expect(a).toEqual({ A: 1 });
    expect(b).toEqual({ B: 2 });
  });

  it('слияние двух конкуррентных доминирует над обоими', () => {
    const a = { A: 2, B: 1 };
    const b = { A: 1, B: 2 };
    const m = merge(a, b);
    expect(dominates(m, a)).toBe(true);
    expect(dominates(m, b)).toBe(true);
    expect(m).toEqual({ A: 2, B: 2 });
  });
});
