import { describe, it, expect } from 'vitest';
import {
  rayAabbHitM,
  nearestObstacleM,
  clearHeadingDeg,
  guidanceRoute,
} from './navigatorGuidance';
import type { MapRect } from './navigatorMapMatch';

const rack = (xM: number, yM: number, lengthM: number, widthM: number): MapRect => ({
  xM,
  yM,
  lengthM,
  widthM,
  kind: 'rack',
});

describe('rayAabbHitM', () => {
  const box = { minX: -1, maxX: 1, minY: 4, maxY: 6 };
  it('луч прямо на коробку — дистанция до ближней грани', () => {
    // из (0,0) на север (0,1): входит в minY=4.
    expect(rayAabbHitM(0, 0, 0, 1, box)).toBeCloseTo(4, 6);
  });
  it('луч мимо коробки — null', () => {
    expect(rayAabbHitM(5, 0, 0, 1, box)).toBeNull();
  });
  it('луч в противоположную сторону — null (коробка позади)', () => {
    expect(rayAabbHitM(0, 0, 0, -1, box)).toBeNull();
  });
  it('начало внутри коробки — 0 (упор)', () => {
    expect(rayAabbHitM(0, 5, 1, 0, box)).toBe(0);
  });
  it('начало на дальней грани и НАРУЖУ — null (луч выходит из коробки)', () => {
    // origin (0,6) на верхней грани box (maxY=6), курс на север (0,1) — покидает коробку.
    expect(rayAabbHitM(0, 6, 0, 1, box)).toBeNull();
  });
});

describe('nearestObstacleM', () => {
  const rects = [rack(0, 5, 4, 2), rack(0, 12, 4, 2)]; // две стены/стеллажа по курсу 0°
  it('берёт БЛИЖАЙШЕЕ препятствие по лучу', () => {
    const d = nearestObstacleM({ xM: 0, yM: 0 }, 0, rects, 20, 0);
    expect(d).toBeCloseTo(4, 6); // ближняя грань первого (5 - 2/2)
  });
  it('далёкое препятствие за пределом дальности игнорируется', () => {
    // maxRange=3 < 4 → ближайшее препятствие «не считается».
    expect(nearestObstacleM({ xM: 0, yM: 0 }, 0, rects, 3, 0)).toBeNull();
  });
  it('зона/проход не препятствие', () => {
    const passage: MapRect = { xM: 0, yM: 5, lengthM: 4, widthM: 2, kind: 'passage' };
    expect(nearestObstacleM({ xM: 0, yM: 0 }, 0, [passage], 20, 0)).toBeNull();
  });
});

describe('clearHeadingDeg', () => {
  it('чистая прямая на цель — без отклонения', () => {
    const r = clearHeadingDeg({ xM: 0, yM: 0 }, { posXM: 0, posYM: 10 }, []);
    expect(r.deflected).toBe(false);
    expect(r.bearingDeg).toBeCloseTo(0, 6); // строго на север
  });
  it('стена прямо по курсу к цели — стрелку отклоняет в сторону', () => {
    // Цель на севере (0,10); стена-стеллаж поперёк прямо перед нами, но проход слева/справа открыт.
    const wall = rack(0, 4, 3, 1); // перекрывает X∈[-1.5,1.5] на Y≈4
    const r = clearHeadingDeg({ xM: 0, yM: 0 }, { posXM: 0, posYM: 10 }, [wall], {
      maxRangeM: 12,
    });
    expect(r.deflected).toBe(true);
    expect(Math.abs(r.bearingDeg)).toBeGreaterThan(0); // увело в сторону от прямой
  });
  it('далёкая стена за горизонтом не выправляет стрелку', () => {
    const wall = rack(0, 30, 3, 1); // очень далеко
    const r = clearHeadingDeg({ xM: 0, yM: 0 }, { posXM: 0, posYM: 50 }, [wall], {
      maxRangeM: 8,
    });
    expect(r.deflected).toBe(false); // дальше maxRange — игнор
  });
  it('отклоняет в достаточно свободный проход, даже если он не чист на всю дальность', () => {
    // Цель далеко (0,14), прямая упёрта стеллажом на Y≈4. Слева проход открыт, но
    // ограничен задней стеной на ~9 м. Раньше needM=min(maxRange,dist) отбраковывал
    // его и стрелка «сдавалась» в стеллаж; теперь needM=straightProbe → обход найден.
    const blocker = rack(0, 4, 3, 1); // поперёк прямой
    const backWallLeft = rack(-6, 9, 1, 0.4); // ограничивает левый проход в глубине
    const r = clearHeadingDeg({ xM: 0, yM: 0 }, { posXM: 0, posYM: 14 }, [blocker, backWallLeft], {
      maxRangeM: 8,
    });
    expect(r.deflected).toBe(true);
  });

  it('целевая ячейка у грани стеллажа не считается упором (приход, не препятствие)', () => {
    // Стеллаж стоит ровно у цели: упор на дистанции цели — это сама полка.
    const shelf = rack(0, 10, 4, 2); // грань на Y≈9, цель за ней на Y=10
    const r = clearHeadingDeg({ xM: 0, yM: 0 }, { posXM: 0, posYM: 10 }, [shelf]);
    expect(r.deflected).toBe(false);
  });
});

describe('guidanceRoute', () => {
  it('без препятствий совпадает с прямым маршрутом (relative к курсу)', () => {
    // Курс на восток (90°), цель на севере → повернуть налево на 90°.
    const r = guidanceRoute({ xM: 0, yM: 0, headingDeg: 90 }, { posXM: 0, posYM: 10 }, []);
    expect(r.distanceM).toBeCloseTo(10, 6);
    expect(r.relativeDeg).toBeCloseTo(-90, 6);
    expect(r.turnText).toBe('Поверните налево');
    expect(r.deflected).toBe(false);
  });
  it('дистанция остаётся прямой даже при обходе (обход не удлиняет цифру)', () => {
    const wall = rack(0, 4, 3, 1);
    const r = guidanceRoute({ xM: 0, yM: 0, headingDeg: 0 }, { posXM: 0, posYM: 10 }, [wall], {
      maxRangeM: 12,
    });
    expect(r.distanceM).toBeCloseTo(10, 6);
    expect(r.deflected).toBe(true);
  });
});
