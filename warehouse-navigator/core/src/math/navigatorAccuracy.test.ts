import { describe, it, expect } from 'vitest';
import {
  createStillnessDetector,
  createGyroBiasEstimator,
  calibrateStrideScale,
} from './navigatorAccuracy';

describe('createStillnessDetector', () => {
  it('низкая дисперсия |a| → стоит', () => {
    const d = createStillnessDetector(600, 0.0025, 5);
    let still = false;
    for (let i = 0; i < 10; i++) still = d.update(1.0 + (i % 2 ? 0.01 : -0.01), i * 50);
    expect(still).toBe(true);
    expect(d.isStill()).toBe(true);
  });
  it('высокая дисперсия |a| (ходьба) → не стоит', () => {
    const d = createStillnessDetector(600, 0.0025, 5);
    let still = true;
    for (let i = 0; i < 10; i++) still = d.update(i % 2 ? 1.4 : 0.6, i * 50);
    expect(still).toBe(false);
  });
  it('мало сэмплов → не стоит (нет данных)', () => {
    const d = createStillnessDetector(600, 0.0025, 5);
    expect(d.update(1.0, 0)).toBe(false);
    expect(d.update(1.0, 50)).toBe(false);
  });
  it('битый замер не роняет', () => {
    const d = createStillnessDetector();
    expect(d.update(NaN, 0)).toBe(false);
  });
});

describe('createGyroBiasEstimator', () => {
  it('в покое учит смещение и вычитает его', () => {
    const e = createGyroBiasEstimator(0.5, 0.2);
    // Сырой гироскоп показывает постоянные 0.1 рад/с, хотя телефон неподвижен → это bias.
    let corrected = 0;
    for (let i = 0; i < 30; i++) corrected = e.update(0.1, true);
    expect(e.bias()).toBeCloseTo(0.1, 2);
    expect(corrected).toBeCloseTo(0, 2); // 0.1 − 0.1 ≈ 0
  });
  it('в движении НЕ учит смещение (флаг still=false)', () => {
    const e = createGyroBiasEstimator(0.5, 0.2);
    for (let i = 0; i < 30; i++) e.update(0.1, false);
    expect(e.bias()).toBeCloseTo(0, 6);
    // Но всё равно вычитает текущий (нулевой) bias — возвращает сырое значение.
    expect(e.update(0.3, false)).toBeCloseTo(0.3, 6);
  });
  it('после обучения в покое корректирует реальный поворот без сдвига нуля', () => {
    const e = createGyroBiasEstimator(0.5, 0.2);
    for (let i = 0; i < 30; i++) e.update(0.05, true); // bias≈0.05
    // Реальный поворот 1.0 рад/с в движении → корректируется на bias.
    expect(e.update(1.0, false)).toBeCloseTo(0.95, 2);
  });
  it('bias ограничен потолком (защита от выброса)', () => {
    const e = createGyroBiasEstimator(1.0, 0.2);
    e.update(5.0, true); // огромный выброс
    expect(Math.abs(e.bias())).toBeLessThanOrEqual(0.2);
  });
  it('битый замер → 0, не портит bias', () => {
    const e = createGyroBiasEstimator();
    expect(e.update(NaN, true)).toBe(0);
    expect(e.bias()).toBe(0);
  });
});

describe('calibrateStrideScale', () => {
  it('PDR переоценил дистанцию → масштаб уменьшается к цели', () => {
    // Прошёл по PDR 12 м, истинно 10 → переоценка ×1.2 → масштаб должен пойти к 1/1.2.
    const s = calibrateStrideScale(10, 12, 1.0, { alpha: 1.0 });
    expect(s).toBeCloseTo(1 / 1.2, 3);
  });
  it('PDR недооценил → масштаб растёт', () => {
    const s = calibrateStrideScale(10, 8, 1.0, { alpha: 1.0 });
    expect(s).toBeCloseTo(1 / 0.8, 3);
  });
  it('короткий отрезок → не калибруем (возврат prevScale)', () => {
    expect(calibrateStrideScale(2, 2.5, 0.9)).toBe(0.9);
  });
  it('неправдоподобный зигзаг (ratio > maxRatio) → не калибруем', () => {
    expect(calibrateStrideScale(10, 20, 1.0)).toBe(1.0); // ratio 2 > 1.5
  });
  it('результат ограничен [scaleMin, scaleMax]', () => {
    const s = calibrateStrideScale(10, 30, 1.0, { alpha: 1.0, maxRatio: 5, scaleMin: 0.6 });
    expect(s).toBe(0.6); // 1/3 зажат снизу
  });
  it('повторная калибровка сходится к истинному масштабу', () => {
    let scale = 1.0;
    // Истинный масштаб 0.8: человек реально делает шаги короче, чем PDR считает.
    // Эмулируем: при scale пройденное = 10/0.8*scale (true=10). Сходимся к 0.8.
    for (let i = 0; i < 20; i++) {
      const pdr = (10 / 0.8) * scale;
      scale = calibrateStrideScale(10, pdr, scale, { alpha: 0.5 });
    }
    expect(scale).toBeCloseTo(0.8, 2);
  });
  it('битые входы → безопасный prevScale', () => {
    expect(calibrateStrideScale(NaN, 12, 0.9)).toBe(0.9);
    expect(calibrateStrideScale(10, NaN, 0.9)).toBe(0.9);
  });
});
