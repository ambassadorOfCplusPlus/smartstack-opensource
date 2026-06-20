import { describe, it, expect } from 'vitest';
import {
  groundHeadingDeg,
  makeArReference,
  arPose,
  warehouseToArGround,
  arTravelM,
  normalizeDeg,
} from './navigatorAr';

const anchorN = { warehouseId: 'w', xM: 0, yM: 0, headingDeg: 0 }; // смотрим на север

describe('groundHeadingDeg', () => {
  it('forward -z = север = 0°', () => {
    expect(groundHeadingDeg(0, -1)).toBeCloseTo(0, 5);
  });
  it('forward +x = восток = 90°', () => {
    expect(groundHeadingDeg(1, 0)).toBeCloseTo(90, 5);
  });
  it('forward +z = юг = 180°', () => {
    expect(groundHeadingDeg(0, 1)).toBeCloseTo(180, 5);
  });
  it('forward -x = запад = 270°', () => {
    expect(groundHeadingDeg(-1, 0)).toBeCloseTo(270, 5);
  });
});

describe('makeArReference', () => {
  it('якорь на север, камера на север (forward -z) → align 0', () => {
    const ref = makeArReference(anchorN, { x: 5, z: -3, fx: 0, fz: -1 });
    expect(ref.yawDeg).toBeCloseTo(0, 5);
    expect(ref.alignDeg).toBeCloseTo(0, 5);
    expect(ref.x).toBe(5);
    expect(ref.z).toBe(-3);
  });
  it('якорь на восток (90°), камера AR на север → align 90', () => {
    const ref = makeArReference({ ...anchorN, headingDeg: 90 }, { x: 0, z: 0, fx: 0, fz: -1 });
    expect(ref.alignDeg).toBeCloseTo(90, 5);
  });
});

describe('arPose (align 0)', () => {
  const ref = makeArReference(anchorN, { x: 0, z: 0, fx: 0, fz: -1 });
  it('шаг по +x (восток AR) → склад X растёт', () => {
    const p = arPose(anchorN, ref, { x: 2, z: 0, fx: 0, fz: -1 });
    expect(p.xM).toBeCloseTo(2, 5);
    expect(p.yM).toBeCloseTo(0, 5);
    expect(p.headingDeg).toBeCloseTo(0, 5);
  });
  it('движение вперёд (-z = север AR) → склад Y растёт', () => {
    const p = arPose(anchorN, ref, { x: 0, z: -3, fx: 0, fz: -1 });
    expect(p.xM).toBeCloseTo(0, 5);
    expect(p.yM).toBeCloseTo(3, 5);
  });
  it('поворот камеры на восток → курс склада 90°', () => {
    const p = arPose(anchorN, ref, { x: 0, z: 0, fx: 1, fz: 0 });
    expect(p.headingDeg).toBeCloseTo(90, 5);
  });
});

describe('arPose (align 90 — якорь смотрел на восток)', () => {
  const anchorE = { ...anchorN, headingDeg: 90 };
  const ref = makeArReference(anchorE, { x: 0, z: 0, fx: 0, fz: -1 });
  it('движение вперёд (-z AR) при align 90 → склад X растёт (шли на восток)', () => {
    const p = arPose(anchorE, ref, { x: 0, z: -1, fx: 0, fz: -1 });
    expect(p.xM).toBeCloseTo(1, 5);
    expect(p.yM).toBeCloseTo(0, 5);
  });
  it('курс камеры (AR север) при align 90 → склад 90°', () => {
    const p = arPose(anchorE, ref, { x: 0, z: 0, fx: 0, fz: -1 });
    expect(p.headingDeg).toBeCloseTo(90, 5);
  });
});

describe('warehouseToArGround — обратное к arPose', () => {
  it('round-trip: точка склада → AR-пол → обратно через arPose', () => {
    const anchor = { warehouseId: 'w', xM: 10, yM: 5, headingDeg: 37 };
    const ref = makeArReference(anchor, { x: 1, z: 2, fx: 0.3, fz: -0.9 });
    const target = { xM: 14, yM: 9 };
    const ground = warehouseToArGround(anchor, ref, target);
    // Подставив AR-координаты цели как замер, arPose должен вернуть ту же точку.
    const back = arPose(anchor, ref, { x: ground.x, z: ground.z, fx: 0, fz: -1 });
    expect(back.xM).toBeCloseTo(target.xM, 4);
    expect(back.yM).toBeCloseTo(target.yM, 4);
  });
});

describe('arTravelM', () => {
  it('евклидова дистанция по полу от референса', () => {
    const ref = makeArReference(anchorN, { x: 0, z: 0, fx: 0, fz: -1 });
    expect(arTravelM(ref, { x: 3, z: -4, fx: 0, fz: -1 })).toBeCloseTo(5, 5);
  });
});

describe('normalizeDeg', () => {
  it('заворачивает в [0,360)', () => {
    expect(normalizeDeg(-90)).toBeCloseTo(270, 5);
    expect(normalizeDeg(450)).toBeCloseTo(90, 5);
  });
});
