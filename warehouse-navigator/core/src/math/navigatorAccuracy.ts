// Приёмы повышения точности PDR поверх базовой математики (navigatorMath). Чистые
// функции/замыкания без React Native — покрыто юнит-тестами (navigatorAccuracy.test.ts).
//
// Реализовано:
//  1) Детектор неподвижности (ZUPT-триггер) — по дисперсии модуля ускорения |a|.
//  2) Оценка дрейфа гироскопа (ZUPT bias) — пока человек стоит, gyroZ обязан быть ~0;
//     любое ненулевое значение — это смещение нуля гироскопа. Учим его и вычитаем →
//     курс перестаёт «уползать» при стоянии и резко меньше дрейфит при ходьбе.
//  3) Калибровка длины шага по паре QR-якорей — при скане следующего якоря знаем
//     ИСТИННОЕ расстояние между якорями; сравниваем с пройденным по PDR и подгоняем
//     масштаб шага под рост/походку конкретного человека.
//
// |a| (модуль ускорения) считает вызывающий через navigatorMath.magnitude3.

// ── 1. Детектор неподвижности ───────────────────────────────────────────────────────
export interface StillnessDetector {
  // Принять модуль ускорения |a| (в g) с меткой времени (мс). Вернуть true, если
  // последнее окно выглядит «человек стоит» (низкая дисперсия |a|).
  update(magG: number, tMs: number): boolean;
  isStill(): boolean;
}

export const STILLNESS_WINDOW_MS = 600;       // окно анализа
export const STILLNESS_VAR_THRESHOLD = 0.0025; // порог дисперсии |a| (g²): σ≈0.05g
export const STILLNESS_MIN_SAMPLES = 5;

export function createStillnessDetector(
  windowMs: number = STILLNESS_WINDOW_MS,
  varThreshold: number = STILLNESS_VAR_THRESHOLD,
  minSamples: number = STILLNESS_MIN_SAMPLES,
): StillnessDetector {
  const buf: Array<{ t: number; v: number }> = [];
  let still = false;
  return {
    update(magG: number, tMs: number): boolean {
      if (!Number.isFinite(magG) || !Number.isFinite(tMs)) return still;
      buf.push({ t: tMs, v: magG });
      while (buf.length > 0 && tMs - buf[0]!.t > windowMs) buf.shift();
      if (buf.length < minSamples) {
        still = false;
        return still;
      }
      let mean = 0;
      for (const s of buf) mean += s.v;
      mean /= buf.length;
      let varSum = 0;
      for (const s of buf) varSum += (s.v - mean) * (s.v - mean);
      const variance = varSum / buf.length;
      still = variance < varThreshold;
      return still;
    },
    isStill(): boolean {
      return still;
    },
  };
}

// ── 2. Оценка и компенсация дрейфа нуля гироскопа (ZUPT) ─────────────────────────────
export interface GyroBiasEstimator {
  // Принять сырую угловую скорость gyroZ (рад/с) и флаг неподвижности. Пока стоим —
  // подучить смещение нуля (EMA). Вернуть СКОМПЕНСИРОВАННУЮ скорость (raw − bias).
  update(rawZ: number, still: boolean): number;
  bias(): number;
}

export const GYRO_BIAS_EMA = 0.05;     // скорость обучения смещения в покое
export const GYRO_BIAS_MAX = 0.2;      // потолок |bias| (рад/с) — защита от выброса

export function createGyroBiasEstimator(
  alpha: number = GYRO_BIAS_EMA,
  maxBias: number = GYRO_BIAS_MAX,
): GyroBiasEstimator {
  let b = 0;
  return {
    update(rawZ: number, still: boolean): number {
      if (!Number.isFinite(rawZ)) return 0;
      // Учим смещение ТОЛЬКО в покое и только по правдоподобно малым значениям
      // (иначе «выучили» бы реальный поворот, начатый до срабатывания детектора).
      if (still && Math.abs(rawZ) < maxBias) {
        b = b * (1 - alpha) + rawZ * alpha;
        if (b > maxBias) b = maxBias;
        else if (b < -maxBias) b = -maxBias;
      }
      return rawZ - b;
    },
    bias(): number {
      return b;
    },
  };
}

// ── 3. Калибровка масштаба длины шага по паре якорей ─────────────────────────────────
export interface StrideCalibrationOptions {
  alpha?: number;     // сглаживание подстройки (доля нового замера)
  minDistM?: number;  // не калибруем на коротких отрезках (шум доминирует)
  scaleMin?: number;  // границы итогового масштаба
  scaleMax?: number;
  maxRatio?: number;  // отвергаем неправдоподобные отрезки (зигзаг/мимо)
}

const STRIDE_DEFAULTS: Required<StrideCalibrationOptions> = {
  alpha: 0.5,
  minDistM: 3,
  scaleMin: 0.6,
  scaleMax: 1.6,
  maxRatio: 1.5,
};

// Подстроить масштаб длины шага: trueDistM — истинное расстояние между якорями A→B
// (прямая), pdrDistM — пройденное по счислению (уже с текущим scale). Возвращает
// новый масштаб (сглаженный, ограниченный). Калибрует только на достаточно прямых,
// длинных отрезках — иначе возвращает prevScale без изменений.
export function calibrateStrideScale(
  trueDistM: number,
  pdrDistM: number,
  prevScale: number,
  options?: StrideCalibrationOptions,
): number {
  const o = { ...STRIDE_DEFAULTS, ...options };
  if (
    !Number.isFinite(trueDistM) ||
    !Number.isFinite(pdrDistM) ||
    !Number.isFinite(prevScale) ||
    prevScale <= 0
  ) {
    return Number.isFinite(prevScale) && prevScale > 0 ? prevScale : 1;
  }
  if (trueDistM < o.minDistM || pdrDistM < o.minDistM) return prevScale;
  const ratio = pdrDistM / trueDistM;
  // Слишком большое расхождение = шли не по прямой (зигзаг) или сбой — не доверяем.
  if (ratio > o.maxRatio || ratio < 1 / o.maxRatio) return prevScale;
  // pdr переоценил в ratio раз → целевой масштаб меньше во столько же.
  const target = prevScale / ratio;
  let next = prevScale + o.alpha * (target - prevScale);
  if (next < o.scaleMin) next = o.scaleMin;
  else if (next > o.scaleMax) next = o.scaleMax;
  return next;
}
