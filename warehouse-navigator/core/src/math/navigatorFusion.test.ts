import { describe, it, expect } from 'vitest';
import { fuseOpticalIntoPdr, type Pose2D } from './navigatorFusion';

const pose = (xM: number, yM: number, headingDeg: number): Pose2D => ({ xM, yM, headingDeg });

describe('fuseOpticalIntoPdr', () => {
  it('нет дрейфа — поза не меняется, snapped=false', () => {
    const r = fuseOpticalIntoPdr(pose(5, 5, 90), pose(5, 5, 90));
    expect(r.snapped).toBe(false);
    expect(r.driftM).toBeCloseTo(0, 6);
    expect(r.pose.xM).toBeCloseTo(5, 6);
    expect(r.pose.headingDeg).toBeCloseTo(90, 6);
  });

  it('малый дрейф — поза мягко тянется к оптике (между PDR и оптикой)', () => {
    // PDR в (0,0), оптика в (1,0), gain 0.15 → x ≈ 0.15.
    const r = fuseOpticalIntoPdr(pose(0, 0, 0), pose(1, 0, 0), { posGainPerUpdate: 0.15 });
    expect(r.snapped).toBe(false);
    expect(r.driftM).toBeCloseTo(1, 6);
    expect(r.pose.xM).toBeCloseTo(0.15, 6);
    expect(r.pose.xM).toBeGreaterThan(0);
    expect(r.pose.xM).toBeLessThan(1); // не перелетает к оптике
  });

  it('крупный дрейф позиции — жёсткий снап к оптике', () => {
    const r = fuseOpticalIntoPdr(pose(0, 0, 0), pose(3, 0, 0), { hardResetM: 2 });
    expect(r.snapped).toBe(true);
    expect(r.driftM).toBeCloseTo(3, 6);
    expect(r.pose.xM).toBeCloseTo(3, 6); // позиция = оптика
  });

  it('крупный дрейф курса — жёсткий снап', () => {
    const r = fuseOpticalIntoPdr(pose(0, 0, 10), pose(0, 0, 80), { hardResetDeg: 30 });
    expect(r.snapped).toBe(true);
    expect(r.driftDeg).toBeCloseTo(70, 6);
    expect(r.pose.headingDeg).toBeCloseTo(80, 6);
  });

  it('малый дрейф курса — курс тянется к оптике по кратчайшей дуге через 0°', () => {
    // PDR 350°, оптика 10° → кратчайшая дуга +20°, трим к 10° на долю 0.5 → ~0°.
    const r = fuseOpticalIntoPdr(pose(0, 0, 350), pose(0, 0, 10), {
      headingGainPerUpdate: 0.5,
      hardResetDeg: 90,
    });
    expect(r.snapped).toBe(false);
    expect(r.pose.headingDeg).toBeCloseTo(0, 6); // 350 + 0.5*20 = 360 → 0
  });

  it('граница снапа (drift == hardResetM) — снап (>=)', () => {
    const r = fuseOpticalIntoPdr(pose(0, 0, 0), pose(2, 0, 0), { hardResetM: 2 });
    expect(r.snapped).toBe(true);
    expect(r.pose.xM).toBeCloseTo(2, 6);
  });

  it('битый оптический замер (NaN) НЕ отравляет позу — ведём PDR', () => {
    const r = fuseOpticalIntoPdr(pose(3, 4, 90), pose(NaN, 0, 0));
    expect(r.snapped).toBe(false);
    expect(Number.isFinite(r.pose.xM)).toBe(true);
    expect(r.pose.xM).toBeCloseTo(3, 6);
    expect(r.pose.yM).toBeCloseTo(4, 6);
    expect(r.pose.headingDeg).toBeCloseTo(90, 6);
  });

  it('Infinity в курсе оптики тоже игнорируется', () => {
    const r = fuseOpticalIntoPdr(pose(1, 1, 45), pose(1, 1, Infinity));
    expect(Number.isFinite(r.pose.headingDeg)).toBe(true);
    expect(r.pose.headingDeg).toBeCloseTo(45, 6);
  });

  it('испорченный PDR (NaN) восстанавливается из оптики', () => {
    const r = fuseOpticalIntoPdr(pose(NaN, NaN, NaN), pose(5, 6, 90));
    expect(r.snapped).toBe(true);
    expect(r.pose.xM).toBeCloseTo(5, 6);
    expect(r.pose.yM).toBeCloseTo(6, 6);
  });

  it('повторная коррекция сходится к оптике (трим не расходится)', () => {
    let p = pose(0, 0, 0);
    const target = pose(2.0 - 0.01, 0, 0); // ниже порога снапа hardResetM=2
    for (let i = 0; i < 50; i++) {
      p = fuseOpticalIntoPdr(p, target, { posGainPerUpdate: 0.2, hardResetM: 2 }).pose;
    }
    expect(p.xM).toBeCloseTo(target.xM, 2); // сошлось к оптике
  });
});
