// Выправление стрелки навигации по 3D-плану склада: прямая стрелка «на цель»
// (computeRoute) может указывать СКВОЗЬ стеллаж/стену. Здесь стрелка проверяется
// по геометрии плана и при упоре в препятствие отклоняется в сторону свободного
// прохода — как на повороте коридора. Чистая геометрия (без React Native), покрыта
// юнит-тестами (navigatorGuidance.test.ts).
//
// Почему НЕ машинное зрение по кадру камеры: план уже ЗНАЕТ, где стены и стеллажи
// (LayoutRect.kind=rack/wall), причём точнее и стабильнее, чем сегментация кадра при
// складском освещении. «Далёкая стена не считается» — это просто потолок дальности
// луча (maxRangeM): препятствия за ним игнорируются. «Крутой поворот учитывается по
// 3D-карте» — это и есть отклонение стрелки в сторону, где луч до препятствия чист.
//
// Система координат — как везде: X восток, Y север (метры); heading 0° = север,
// по часовой. Направление курса как вектор пола: (sin h, cos h) = (восток, север).

import type { MapRect } from './navigatorMapMatch.js';
import { rectAabb, OBSTACLE_KINDS } from './navigatorMapMatch.js';
import { normalizeDeg, signedDeltaDeg, turnTextForRelative } from './navigatorMath.js';

export interface GuidanceOptions {
  // Дальше этого препятствия по лучу не учитываются (далёкая стена не выправляет
  // стрелку). Типичная ширина прохода-перспективы склада ~ 6–10 м.
  maxRangeM?: number;
  // Запас обхода вокруг стеллажа/стены (стрелка ведёт не впритык к грани).
  marginM?: number;
  // Максимальное отклонение стрелки от направления на цель. Сильнее не отклоняем —
  // лучше показать «на цель», чем увести в противоположную сторону.
  maxDeflectionDeg?: number;
  // Шаг сканирования углов обхода.
  stepDeg?: number;
}

const DEFAULTS: Required<GuidanceOptions> = {
  maxRangeM: 8,
  marginM: 0.3,
  maxDeflectionDeg: 90,
  stepDeg: 5,
};

export interface GuidanceResult {
  distanceM: number; // прямая дистанция до цели (стрелку обход не удлиняет)
  bearingDeg: number; // АБСОЛЮТНЫЙ курс выправленной стрелки (0..360)
  relativeDeg: number; // угол стрелки относительно текущего курса (-180..180, + = направо)
  turnText: string;
  deflected: boolean; // true — прямая на цель упиралась в препятствие, стрелку отклонили
}

// Дистанция по лучу (ox,oy)+t·(dx,dy), |(dx,dy)|=1, до ВХОДА в AABB `b` (метры).
// null — луч не пересекает коробку впереди. Если начало внутри коробки — 0 (упор).
// Метод слэбов (2D): пересечение интервалов входа/выхода по осям X и Y.
export function rayAabbHitM(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  b: { minX: number; maxX: number; minY: number; maxY: number },
): number | null {
  const EPS = 1e-9;
  let tmin = -Infinity;
  let tmax = Infinity;
  // Ось X.
  if (Math.abs(dx) < EPS) {
    if (ox < b.minX || ox > b.maxX) return null; // параллельно и вне полосы
  } else {
    let t1 = (b.minX - ox) / dx;
    let t2 = (b.maxX - ox) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  // Ось Y.
  if (Math.abs(dy) < EPS) {
    if (oy < b.minY || oy > b.maxY) return null;
  } else {
    let t1 = (b.minY - oy) / dy;
    let t2 = (b.maxY - oy) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  if (tmax < Math.max(tmin, 0)) return null; // пересечения впереди нет
  // tmin<0: начало внутри коробки (tmax>0) → упор сразу (0). Ровно на дальней грани и
  // НАРУЖУ (tmax==0) — луч выходит из коробки, препятствия впереди нет → null.
  if (tmin < 0) return tmax > 0 ? 0 : null;
  return tmin;
}

// Ближайшее препятствие (rack/wall) по лучу из `from` в направлении headingDeg,
// в пределах maxRangeM (коробки расширены на marginM). null — путь чист.
export function nearestObstacleM(
  from: { xM: number; yM: number },
  headingDeg: number,
  rects: MapRect[],
  maxRangeM: number,
  marginM: number,
): number | null {
  const rad = (headingDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = Math.cos(rad);
  let best: number | null = null;
  for (const r of rects) {
    if (!OBSTACLE_KINDS.has(r.kind ?? 'rack')) continue;
    const a = rectAabb(r);
    const box = {
      minX: a.minX - marginM,
      maxX: a.maxX + marginM,
      minY: a.minY - marginM,
      maxY: a.maxY + marginM,
    };
    const t = rayAabbHitM(from.xM, from.yM, dx, dy, box);
    if (t === null || t > maxRangeM) continue;
    if (best === null || t < best) best = t;
  }
  return best;
}

// Выправленный курс стрелки: на цель, если прямая чиста; иначе — наименьшее
// отклонение, при котором луч свободен на нужную дальность. `pose` — «вы здесь»
// (нужны xM/yM; курс для выбора стороны не требуется).
export function clearHeadingDeg(
  pose: { xM: number; yM: number },
  target: { posXM: number; posYM: number },
  rects: MapRect[],
  options?: GuidanceOptions,
): { bearingDeg: number; deflected: boolean } {
  const o = { ...DEFAULTS, ...options };
  const dx = target.posXM - pose.xM;
  const dy = target.posYM - pose.yM;
  const dist = Math.hypot(dx, dy);
  const bearing = normalizeDeg((Math.atan2(dx, dy) * 180) / Math.PI);
  if (dist < 1e-6) return { bearingDeg: bearing, deflected: false };

  // На цель смотрим только до неё (минус запас): сама целевая ячейка стоит у грани
  // стеллажа, и «упор» в этот стеллаж на дистанции цели — НЕ препятствие, а приход.
  const reachM = o.marginM + 0.4;
  const straightProbe = Math.max(0, Math.min(dist - reachM, o.maxRangeM));
  const straightHit = nearestObstacleM(pose, bearing, rects, o.maxRangeM, o.marginM);
  if (straightHit === null || straightHit >= straightProbe) {
    return { bearingDeg: bearing, deflected: false };
  }

  // Прямая упёрлась: ищем сторону обхода. Нужный «чистый» пробег для отклонённого
  // луча — ТОТ ЖЕ, что требовали от прямой (straightProbe). Раньше тут было
  // min(maxRange,dist) без вычета reachM — это строже, чем тест прямой, и отбраковывало
  // достаточно свободные проходы, после чего обход «сдавался» и стрелка била в стеллаж.
  const needM = straightProbe;
  for (let off = o.stepDeg; off <= o.maxDeflectionDeg; off += o.stepDeg) {
    const right = normalizeDeg(bearing + off);
    const left = normalizeDeg(bearing - off);
    const hr = nearestObstacleM(pose, right, rects, o.maxRangeM, o.marginM);
    const hl = nearestObstacleM(pose, left, rects, o.maxRangeM, o.marginM);
    const clrR = hr === null ? Infinity : hr;
    const clrL = hl === null ? Infinity : hl;
    const okR = clrR >= needM;
    const okL = clrL >= needM;
    if (okR && okL) return { bearingDeg: clrR >= clrL ? right : left, deflected: true };
    if (okR) return { bearingDeg: right, deflected: true };
    if (okL) return { bearingDeg: left, deflected: true };
  }
  // Чистой стороны не нашли — лучше указать на цель, чем крутить стрелку.
  return { bearingDeg: bearing, deflected: false };
}

// Маршрут с выправленной по плану стрелкой — замена computeRoute для UI, когда
// известен план склада (rects). Без препятствий совпадает с computeRoute.
export function guidanceRoute(
  anchor: { xM: number; yM: number; headingDeg: number },
  target: { posXM: number; posYM: number },
  rects: MapRect[],
  options?: GuidanceOptions,
): GuidanceResult {
  const dx = target.posXM - anchor.xM;
  const dy = target.posYM - anchor.yM;
  const distanceM = Math.hypot(dx, dy);
  const { bearingDeg, deflected } = clearHeadingDeg(anchor, target, rects, options);
  const relativeDeg = signedDeltaDeg(bearingDeg - anchor.headingDeg);
  return { distanceM, bearingDeg, relativeDeg, turnText: turnTextForRelative(relativeDeg), deflected };
}
