import { describe, it, expect } from 'vitest';
import { rectAabb, snapOutOfObstacles, type MapRect } from './navigatorMapMatch';

const rack = (xM: number, yM: number, lengthM: number, widthM: number, rotationDeg = 0): MapRect => ({
  xM,
  yM,
  lengthM,
  widthM,
  rotationDeg,
  kind: 'rack',
});

describe('rectAabb', () => {
  it('без поворота — половинки по длине/ширине', () => {
    expect(rectAabb(rack(5, 5, 4, 2))).toEqual({ minX: 3, maxX: 7, minY: 4, maxY: 6 });
  });
  it('поворот 90° меняет оси местами', () => {
    expect(rectAabb(rack(5, 5, 4, 2, 90))).toEqual({ minX: 4, maxX: 6, minY: 3, maxY: 7 });
  });
  it('малый угол у длинного тонкого стеллажа НЕ раздувает коробку (точная AABB)', () => {
    // Стеллаж 10×1 повёрнут на 5°: по Y полу-размер ≈0.93, а описанная окружность
    // (старое поведение) дала бы ≈5.0 — раздув в 5 раз.
    const b = rectAabb(rack(0, 0, 10, 1, 5));
    expect(b.maxY).toBeLessThan(1.1);
    expect(b.maxX).toBeGreaterThan(4.9);
    expect(b.maxX).toBeLessThan(5.2);
  });
});

describe('snapOutOfObstacles', () => {
  const racks = [rack(5, 5, 4, 2)]; // занимает X∈[3,7], Y∈[4,6]
  it('точка в свободном пространстве не меняется', () => {
    expect(snapOutOfObstacles({ xM: 0, yM: 0 }, racks)).toEqual({ xM: 0, yM: 0 });
  });
  it('точка внутри стеллажа выталкивается по оси наименьшего проникновения', () => {
    // (6.5, 5): ближе всего правый край X=7 → выталкиваем по X.
    expect(snapOutOfObstacles({ xM: 6.5, yM: 5 }, racks)).toEqual({ xM: 7, yM: 5 });
    // (5, 5.8): ближе верхний край Y=6 → выталкиваем по Y.
    expect(snapOutOfObstacles({ xM: 5, yM: 5.8 }, racks)).toEqual({ xM: 5, yM: 6 });
  });
  it('зоны/проходы — проходимы (не препятствие)', () => {
    const zone: MapRect = { ...rack(5, 5, 4, 2), kind: 'zone' };
    expect(snapOutOfObstacles({ xM: 5, yM: 5 }, [zone])).toEqual({ xM: 5, yM: 5 });
  });
  it('запас marginM расширяет препятствие', () => {
    // (7.3, 5) вне [3,7] по X, но с margin 0.5 попадает в [2.5,7.5] → вытолкнут к 7.5.
    expect(snapOutOfObstacles({ xM: 7.3, yM: 5 }, racks, 0.5)).toEqual({ xM: 7.5, yM: 5 });
  });
  it('два смежных стеллажа: итерация выталкивает наружу ОБОИХ', () => {
    // A: X∈[3,7], B: X∈[7,11], оба Y∈[4,6]. Точка (6.6,5) внутри A; одиночный проход
    // вытолкнул бы к X=7 — на границу B. Итерация должна вывести наружу обоих.
    const two = [rack(5, 5, 4, 2), rack(9, 5, 4, 2)];
    const r = snapOutOfObstacles({ xM: 6.6, yM: 5 }, two);
    const inA = r.xM > 3 && r.xM < 7 && r.yM > 4 && r.yM < 6;
    const inB = r.xM > 7 && r.xM < 11 && r.yM > 4 && r.yM < 6;
    expect(inA).toBe(false);
    expect(inB).toBe(false);
  });
  it('`from` выталкивает на сторону, откуда пришли (не сквозь тонкую стену)', () => {
    // Тонкая стена X∈[4.9,5.1], Y∈[4,6]. Пришли слева (from x=4), перескочили за
    // середину в (5.05,5). По наименьшему проникновению ушли бы вправо (X=5.1, сквозь
    // стену); с from — обратно влево к X=4.9.
    const wall: MapRect = { xM: 5, yM: 5, lengthM: 0.2, widthM: 2, rotationDeg: 0, kind: 'wall' };
    const r = snapOutOfObstacles({ xM: 5.05, yM: 5 }, [wall], 0, { xM: 4, yM: 5 });
    expect(r.xM).toBeCloseTo(4.9, 5);
  });
});
