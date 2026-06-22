// Оптическо-инерциальная фузия: счисление по датчикам (PDR — шагомер + компас +
// гироскоп) даёт высокую частоту и работает в темноте/у глухой стены, но НАКАПЛИВАЕТ
// дрейф (ошибка длины шага и курса растёт с пройденным путём). Оптика (ARCore/ARKit
// VIO) дрейф-корректирована визуальными признаками — она «видит» накопленную ошибку
// датчиков и выправляет её. Здесь — чистая математика слияния (без React Native),
// покрыта юнит-тестами (navigatorFusion.test.ts).
//
// Идея: PDR — основа (быстрый, всегда доступен), оптика — корректор. Пока расхождение
// мало, оптика МЯГКО подтягивает позу счисления к себе (трим дрейфа без рывков). Когда
// расхождение крупное (большой дрейф, «видимый оптикой»), оптика выправляет ЖЁСТКО —
// автоматический аналог пересканирования QR-якоря, но без участия человека.
//
// Координаты склада: X восток, Y север (метры); heading 0° = север, по часовой.

import { signedDeltaDeg, smoothHeading } from './navigatorMath.js';

export interface Pose2D {
  xM: number;
  yM: number;
  headingDeg: number;
}

export interface OpticalFusionOptions {
  // Доля коррекции позиции к оптике за один замер (мягкий трим, 0..1).
  posGainPerUpdate?: number;
  // Доля коррекции курса к оптике за один замер (0..1).
  headingGainPerUpdate?: number;
  // Расхождение позиции (м), при котором оптика выправляет ЖЁСТКО (снап к оптике).
  hardResetM?: number;
  // Расхождение курса (град), при котором снап.
  hardResetDeg?: number;
}

export interface OpticalFusionResult {
  pose: Pose2D; // выправленная поза (фузия PDR + оптика)
  driftM: number; // расхождение позиции PDR↔оптика ДО коррекции
  driftDeg: number; // расхождение курса ДО коррекции (0..180)
  snapped: boolean; // true — крупный дрейф выправлен жёстко (снап к оптике)
}

const DEFAULTS: Required<OpticalFusionOptions> = {
  posGainPerUpdate: 0.15,
  headingGainPerUpdate: 0.05,
  hardResetM: 2.0,
  hardResetDeg: 30,
};

// Выправить позу счисления (pdr) оптической позой (optical, от ARCore). Малый дрейф —
// мягкий трим к оптике; крупный (≥ порогов) — жёсткий снап. Возвращает выправленную
// позу и измеренный дрейф (для индикатора «оптика подстраивает/выправила»).
export function fuseOpticalIntoPdr(
  pdr: Pose2D,
  optical: Pose2D,
  options?: OpticalFusionOptions,
): OpticalFusionResult {
  const o = { ...DEFAULTS, ...options };
  // Защита от NaN/Inf: один битый замер иначе через soft-trim (pdr + gain*NaN)
  // навсегда отравил бы позу (она возвращается как база следующего кадра).
  const finite = (p: Pose2D) =>
    Number.isFinite(p.xM) && Number.isFinite(p.yM) && Number.isFinite(p.headingDeg);
  if (!finite(optical)) {
    return { pose: { ...pdr }, driftM: 0, driftDeg: 0, snapped: false }; // битая оптика — ведём PDR
  }
  if (!finite(pdr)) {
    return { pose: { ...optical }, driftM: 0, driftDeg: 0, snapped: true }; // PDR испорчен — берём оптику
  }
  const dx = optical.xM - pdr.xM;
  const dy = optical.yM - pdr.yM;
  const driftM = Math.hypot(dx, dy);
  const driftDeg = Math.abs(signedDeltaDeg(optical.headingDeg - pdr.headingDeg));

  if (driftM >= o.hardResetM || driftDeg >= o.hardResetDeg) {
    // Большой дрейф «увиден оптикой» → выправляем жёстко (снап к дрейф-свободной оптике).
    return { pose: { ...optical }, driftM, driftDeg, snapped: true };
  }
  // Мягкий трим: тянем позу и курс к оптике на долю усиления (без рывков).
  return {
    pose: {
      xM: pdr.xM + o.posGainPerUpdate * dx,
      yM: pdr.yM + o.posGainPerUpdate * dy,
      headingDeg: smoothHeading(pdr.headingDeg, optical.headingDeg, o.headingGainPerUpdate),
    },
    driftM,
    driftDeg,
    snapped: false,
  };
}
