import { describe, it, expect } from 'vitest';
import {
  magnetometerToHeadingDeg,
  tiltCompensatedHeadingDeg,
  smoothHeading,
  stepDelta,
  weinbergStepLength,
  createStepDetector,
  fuseHeadingComplementary,
  isMagneticAnomaly,
  magnitude3,
  normalizeDeg,
  signedDeltaDeg,
  parseAnchor,
  computeRoute,
  nearestMappedCell,
} from './navigatorMath';

const cell = (cellId: string, posXM: number | null, posYM: number | null) => ({
  cellId,
  code: cellId,
  posXM,
  posYM,
  quantity: 1,
});

describe('magnetometerToHeadingDeg', () => {
  it('север (+Y) = 0°', () => {
    expect(magnetometerToHeadingDeg(0, 1)).toBeCloseTo(0, 5);
  });
  it('восток (+X) = 90°', () => {
    expect(magnetometerToHeadingDeg(1, 0)).toBeCloseTo(90, 5);
  });
  it('юг (-Y) = 180°', () => {
    expect(magnetometerToHeadingDeg(0, -1)).toBeCloseTo(180, 5);
  });
  it('запад (-X) = 270°, нормализуется в [0,360)', () => {
    expect(magnetometerToHeadingDeg(-1, 0)).toBeCloseTo(270, 5);
  });
});

describe('tiltCompensatedHeadingDeg', () => {
  // Конструктивно: при горизонтальном телефоне (a=(0,0,1)) совпадает с плоской формулой.
  const flatA: [number, number, number] = [0, 0, 1];
  it('плоский телефон → как magnetometerToHeadingDeg(mx,my)', () => {
    for (const [mx, my] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
      [0.3, 0.7],
      [-2, 5],
    ] as Array<[number, number]>) {
      expect(tiltCompensatedHeadingDeg(mx, my, 7, ...flatA)).toBeCloseTo(
        magnetometerToHeadingDeg(mx, my),
        5,
      );
    }
  });
  it('вертикальная компонента mz не влияет в плоском случае', () => {
    expect(tiltCompensatedHeadingDeg(1, 2, 5, ...flatA)).toBeCloseTo(
      tiltCompensatedHeadingDeg(1, 2, -99, ...flatA),
      5,
    );
  });
  it('результат всегда в [0,360)', () => {
    const h = tiltCompensatedHeadingDeg(0.4, -0.2, 0.6, 0.1, 0.3, 0.95);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
  it('наклон вперёд сохраняет курс «на север» (поле north горизонтальное)', () => {
    // Телефон смотрит на север, поле строго на север (device: my). Наклон вперёд
    // (pitch) уводит часть поля в device z; компенсация должна вернуть ~0°.
    const th = (30 * Math.PI) / 180;
    // при pitch вперёд: гравитация даёт ax≈0, ay≈-sin, az≈cos; поле north проецируется
    // в my=cos, mz=+sin (часть «север» уходит в z экрана).
    const h = tiltCompensatedHeadingDeg(0, Math.cos(th), Math.sin(th), 0, -Math.sin(th), Math.cos(th));
    expect(Math.min(h, 360 - h)).toBeLessThan(2); // ≈0°
  });
});

describe('smoothHeading', () => {
  it('alpha=1 → берёт новое значение', () => {
    expect(smoothHeading(10, 80, 1)).toBeCloseTo(80, 5);
  });
  it('alpha=0 → держит старое', () => {
    expect(smoothHeading(10, 80, 0)).toBeCloseTo(10, 5);
  });
  it('идёт по кратчайшей дуге через 0° (359°→1° = вперёд, не назад)', () => {
    // короткая дельта +2°, alpha 0.5 → 360° == 0°
    const r = smoothHeading(359, 1, 0.5);
    expect(Math.min(r, 360 - r)).toBeCloseTo(0, 5);
  });
  it('результат всегда в [0,360)', () => {
    const r = smoothHeading(350, 20, 0.5);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(360);
  });
});

describe('weinbergStepLength', () => {
  it('растёт с размахом ускорения (монотонно)', () => {
    expect(weinbergStepLength(0.5)).toBeLessThan(weinbergStepLength(2));
  });
  it('ограничен разумным диапазоном шага [0.3, 1.2]', () => {
    expect(weinbergStepLength(0)).toBe(0.3);
    expect(weinbergStepLength(1000)).toBe(1.2);
  });
  it('отрицательный вход → клампится к минимуму', () => {
    expect(weinbergStepLength(-5)).toBe(0.3);
  });
  it('NaN/Infinity → минимальный шаг (битый замер не корёжит дистанцию)', () => {
    expect(weinbergStepLength(NaN)).toBe(0.3);
    expect(weinbergStepLength(Infinity)).toBe(0.3);
  });
});

describe('normalizeDeg / signedDeltaDeg', () => {
  it('normalizeDeg → [0,360)', () => {
    expect(normalizeDeg(-90)).toBeCloseTo(270, 5);
    expect(normalizeDeg(450)).toBeCloseTo(90, 5);
    expect(normalizeDeg(360)).toBeCloseTo(0, 5);
  });
  it('signedDeltaDeg → (-180,180]', () => {
    expect(signedDeltaDeg(90)).toBeCloseTo(90, 5);
    expect(signedDeltaDeg(-90)).toBeCloseTo(-90, 5);
    expect(signedDeltaDeg(270)).toBeCloseTo(-90, 5); // кратчайшая дуга
    expect(signedDeltaDeg(180)).toBeCloseTo(-180, 5);
    expect(signedDeltaDeg(181)).toBeCloseTo(-179, 5);
  });
});

describe('createStepDetector', () => {
  it('ровный сигнал (стоим) → шагов нет', () => {
    const det = createStepDetector();
    let steps = 0;
    for (let i = 0; i < 100; i++) if (det.update(1.0, i * 50) !== null) steps++;
    expect(steps).toBe(0);
  });
  it('синтетическая ходьба → ловит шаги, каждая длина в [0.3,1.2]', () => {
    const det = createStepDetector();
    const lens: number[] = [];
    // 4 с при 20 Гц, ~1.8 шаг/с, размах |a| ~0.6 g.
    for (let i = 0; i < 80; i++) {
      const t = i * 50;
      const mag = 1 + 0.3 * Math.sin((2 * Math.PI * 1.8 * t) / 1000);
      const len = det.update(mag, t);
      if (len !== null) lens.push(len);
    }
    expect(lens.length).toBeGreaterThanOrEqual(4);
    expect(lens.length).toBeLessThanOrEqual(9);
    for (const l of lens) {
      expect(l).toBeGreaterThanOrEqual(0.3);
      expect(l).toBeLessThanOrEqual(1.2);
    }
  });
  it('первый пик калибрует (не шаг), рефрактерный период гасит частую тряску', () => {
    const det = createStepDetector();
    const out: Array<number | null> = [];
    det.update(1.0, 0); // база среднего
    det.update(1.5, 10); // пик
    out.push(det.update(0.9, 20)); // спад → ПРАЙМ (null)
    det.update(1.5, 100); // пик
    out.push(det.update(0.9, 110)); // спад через 90 мс < 250 → отклонён (null)
    det.update(1.5, 400); // пик
    out.push(det.update(0.9, 410)); // спад через 390 мс ≥ 250 → ШАГ
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).not.toBeNull();
    expect(out[2] as number).toBeGreaterThanOrEqual(0.3);
    expect(out[2] as number).toBeLessThanOrEqual(1.2);
  });
});

describe('fuseHeadingComplementary', () => {
  it('alpha=0 → чистое интегрирование гироскопа', () => {
    // gyro 90°/с (π/2 рад/с) за 1 c → +90° к prev.
    const h = fuseHeadingComplementary(10, Math.PI / 2, 1, 999, 0);
    expect(h).toBeCloseTo(100, 4);
  });
  it('alpha=1 → берёт магнитный курс', () => {
    expect(fuseHeadingComplementary(10, 0, 1, 200, 1)).toBeCloseTo(200, 4);
  });
  it('результат в [0,360) с заворотом', () => {
    const h = fuseHeadingComplementary(350, Math.PI / 2, 1, 0, 0); // 350+90=440→80
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
    expect(h).toBeCloseTo(80, 4);
  });
  it('битый гироскоп (NaN) → курс не меняется', () => {
    expect(fuseHeadingComplementary(42, NaN, 1, 90)).toBe(42);
  });
  it('нет магнитной цели (NaN) → чистое интегрирование гироскопа', () => {
    // 90°/с за 1с к prev=10 → 100, без подтяжки к магнитному курсу.
    expect(fuseHeadingComplementary(10, Math.PI / 2, 1, NaN, 1)).toBeCloseTo(100, 4);
  });
});

describe('isMagneticAnomaly / magnitude3', () => {
  it('magnitude3 — евклидова норма', () => {
    expect(magnitude3(3, 4, 0)).toBeCloseTo(5, 5);
  });
  it('базовая линия не набрана (≤0) → не аномалия', () => {
    expect(isMagneticAnomaly(100, 0)).toBe(false);
  });
  it('в пределах допуска → не аномалия; за пределами → аномалия', () => {
    expect(isMagneticAnomaly(48, 50, 0.3)).toBe(false); // 4% отклонение
    expect(isMagneticAnomaly(80, 50, 0.3)).toBe(true); // 60% — рядом с металлом
  });
  it('NaN модуль → аномалия (битому замеру не доверяем)', () => {
    expect(isMagneticAnomaly(NaN, 50, 0.3)).toBe(true);
  });
});

describe('stepDelta', () => {
  it('курс 0° (север) → движение по +Y', () => {
    const { dx, dy } = stepDelta(0, 1);
    expect(dx).toBeCloseTo(0, 5);
    expect(dy).toBeCloseTo(1, 5);
  });
  it('курс 90° (восток) → движение по +X', () => {
    const { dx, dy } = stepDelta(90, 2);
    expect(dx).toBeCloseTo(2, 5);
    expect(dy).toBeCloseTo(0, 5);
  });
});

describe('parseAnchor', () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  it('валидная метка → объект', () => {
    expect(parseAnchor(`SSNAV1|${uuid}|3.5|-2|90`)).toEqual({
      warehouseId: uuid,
      xM: 3.5,
      yM: -2,
      headingDeg: 90,
    });
  });
  it('обрезает пробелы по краям', () => {
    expect(parseAnchor(`  SSNAV1|${uuid}|0|0|0  `)).not.toBeNull();
  });
  it('чужой префикс → null', () => {
    expect(parseAnchor(`SSNAV2|${uuid}|0|0|0`)).toBeNull();
  });
  it('не-UUID склад → null', () => {
    expect(parseAnchor('SSNAV1|not-a-uuid|0|0|0')).toBeNull();
  });
  it('нечисловые координаты → null', () => {
    expect(parseAnchor(`SSNAV1|${uuid}|x|0|0`)).toBeNull();
  });
  it('неверное число полей → null', () => {
    expect(parseAnchor(`SSNAV1|${uuid}|0|0`)).toBeNull();
  });
});

describe('nearestMappedCell', () => {
  const pose = { xM: 0, yM: 0 };
  it('фильтрует ячейки без координат и берёт ближайшую', () => {
    const r = nearestMappedCell(pose, [
      cell('A', 10, 0),
      cell('B', null, null),
      cell('C', 2, 0),
    ]);
    expect(r.mapped.map((c) => c.cellId)).toEqual(['A', 'C']);
    expect(r.target?.cellId).toBe('C');
  });
  it('нет размеченных ячеек → target null', () => {
    const r = nearestMappedCell(pose, [cell('B', null, null)]);
    expect(r.mapped).toHaveLength(0);
    expect(r.target).toBeNull();
  });
  it('нет позы → target null, но mapped возвращается', () => {
    const r = nearestMappedCell(null, [cell('A', 1, 1)]);
    expect(r.target).toBeNull();
    expect(r.mapped).toHaveLength(1);
  });
});

describe('computeRoute', () => {
  const anchor = { warehouseId: 'w', xM: 0, yM: 0, headingDeg: 0 };
  it('цель прямо по курсу (на север) → «Идите прямо»', () => {
    const r = computeRoute(anchor, { posXM: 0, posYM: 10 });
    expect(r.distanceM).toBeCloseTo(10, 5);
    expect(Math.abs(r.relativeDeg)).toBeLessThan(15);
    expect(r.turnText).toBe('Идите прямо');
  });
  it('цель строго справа (восток) при курсе на север → «Поверните направо»', () => {
    const r = computeRoute(anchor, { posXM: 10, posYM: 0 });
    expect(r.relativeDeg).toBeCloseTo(90, 5);
    expect(r.turnText).toBe('Поверните направо');
  });
  it('цель слева (запад) → «Поверните налево», relativeDeg < 0', () => {
    const r = computeRoute(anchor, { posXM: -10, posYM: 0 });
    expect(r.relativeDeg).toBeCloseTo(-90, 5);
    expect(r.turnText).toBe('Поверните налево');
  });
  it('цель сзади (юг) → «Развернитесь назад»', () => {
    const r = computeRoute(anchor, { posXM: 0, posYM: -10 });
    expect(Math.abs(r.relativeDeg)).toBeGreaterThan(165);
    expect(r.turnText).toBe('Развернитесь назад');
  });
  it('учитывает текущий heading: цель на восток, но и смотрим на восток → прямо', () => {
    const r = computeRoute({ ...anchor, headingDeg: 90 }, { posXM: 10, posYM: 0 });
    expect(Math.abs(r.relativeDeg)).toBeLessThan(15);
    expect(r.turnText).toBe('Идите прямо');
  });
});
