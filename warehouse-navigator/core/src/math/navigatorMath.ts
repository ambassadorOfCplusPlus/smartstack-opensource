// Чистая геометрия и счисление по датчикам (PDR) для навигатора по складу.
// Без импортов React Native — модуль покрыт юнит-тестами (navigatorMath.test.ts).
// Координаты склада: X вправо (восток), Y вверх (север), метры. headingDeg —
// азимут (0° = вверх/север по карте, по часовой стрелке).
import type { NavAnchor, ProductLocation } from '../model.js';

// Средняя длина шага человека (м) — смещение точки «вы здесь» на каждый шаг.
// Грубая константа: PDR это best-effort оценка.
export const STEP_LENGTH_M = 0.7;
// Частота магнитометра (мс) — умеренная, чтобы не разряжать батарею.
export const MAGNETOMETER_INTERVAL_MS = 200;
// Частота акселерометра (мс) — ВЫШЕ магнитометра: модель Вайнберга берёт размах
// ускорения за шаг (~0.4–0.6 с), на 5 Гц шаг недосэмплирован. 20 Гц достаточно.
export const ACCELEROMETER_INTERVAL_MS = 50;
// Максимальный «разумный» интервал между замерами гироскопа (с): больше — значит был
// разрыв (фон/засыпание), интегрировать такой dt нельзя.
export const GYRO_MAX_DT_SEC = 1;
// Окно «свежести» гироскопа (мс): если последний замер гироскопа старше — считаем,
// что гироскопа нет/он замолчал, и курс снова ведёт магнитометр напрямую.
export const GYRO_FRESH_MS = 3 * MAGNETOMETER_INTERVAL_MS;
// Вес EMA базовой линии модуля магнитного поля (доля нового замера).
export const MAG_BASELINE_EMA = 0.1;
// Сколько «аномалий» подряд терпим, прежде чем переинициализировать базовую линию:
// защита от захвата линии выбросом (старт у металла) или смены среды.
export const MAG_BASELINE_RESET_SAMPLES = 15;
// Порог дрейфа PDR (м): пройдя столько без скана, советуем пересканировать якорь
// (счисление накапливает ошибку, точный сброс — только по QR).
export const PDR_RESCAN_HINT_M = 15;
// Коэффициент сглаживания курса (0..1): доля нового замера в фильтре. Меньше —
// плавнее и инертнее (сырой магнитометр шумит, особенно среди металла на складе).
export const HEADING_SMOOTHING_ALPHA = 0.2;

// Нормализация угла в [0,360).
export function normalizeDeg(d: number): number {
  return ((d % 360) + 360) % 360;
}

// Кратчайшая ЗНАКОВАЯ дельта угла, приведённая к (-180, 180] (+ = по часовой).
export function signedDeltaDeg(d: number): number {
  return (((d % 360) + 540) % 360) - 180;
}

// Азимут (0..360, по часовой от «вверх/севера») из вектора магнитометра {x,y}.
// Это компасный курс телефона в плоскости экрана. Та же система, что headingDeg
// якоря (градусы по часовой от севера), поэтому курс компаса напрямую годится
// как направление движения по карте склада.
export function magnetometerToHeadingDeg(x: number, y: number): number {
  // atan2(x, y): 0° когда вектор направлен «вверх» (+Y), растёт по часовой.
  const deg = (Math.atan2(x, y) * 180) / Math.PI;
  return normalizeDeg(deg);
}

// Курс с КОМПЕНСАЦИЕЙ НАКЛОНА (eCompass): по магнитометру (mx,my,mz) и вектору
// гравитации с акселерометра (ax,ay,az). Поворот горизонтальной проекции магнитного
// поля в плоскость пола убирает зависимость от наклона телефона — курс верен, когда
// телефон держат не строго горизонтально (типичный случай при ходьбе и чтении карты).
// Конструктивно при горизонтальном телефоне (a≈(0,0,1)) сводится к
// magnetometerToHeadingDeg(mx,my), поэтому поведение в «плоском» случае не меняется,
// а при наклоне — точнее. Оси expo-sensors: x — вправо, y — вверх, z — из экрана.
export function tiltCompensatedHeadingDeg(
  mx: number,
  my: number,
  mz: number,
  ax: number,
  ay: number,
  az: number,
): number {
  const gnorm = magnitude3(ax, ay, az) || 1;
  const gx = ax / gnorm;
  const gy = ay / gnorm;
  const gz = az / gnorm;
  const roll = Math.atan2(gy, gz); // вокруг X
  const pitch = Math.atan2(-gx, Math.hypot(gy, gz)); // вокруг Y
  const sinR = Math.sin(roll);
  const cosR = Math.cos(roll);
  const sinP = Math.sin(pitch);
  const cosP = Math.cos(pitch);
  // Горизонтальные компоненты магнитного поля (в плоскости пола).
  const mhx = mx * cosP + mz * sinP;
  const mhy = mx * sinR * sinP + my * cosR - mz * sinR * cosP;
  return magnetometerToHeadingDeg(mhx, mhy);
}

// Круговое сглаживание курса (низкочастотный фильтр) с корректной обработкой
// перехода через 0°/360°: идём по КРАТЧАЙШЕЙ дуге, иначе фильтр «прыгал» бы
// через полный круг на стыке (например с 359° на 1°). Возвращает курс 0..360.
export function smoothHeading(
  prev: number,
  next: number,
  alpha: number = HEADING_SMOOTHING_ALPHA,
): number {
  const diff = signedDeltaDeg(next - prev); // кратчайшая дельта (-180,180]
  return normalizeDeg(prev + alpha * diff);
}

// Смещение позиции на один шаг в направлении курса (heading, по часовой от +Y).
export function stepDelta(headingDeg: number, stepM: number): { dx: number; dy: number } {
  const rad = (headingDeg * Math.PI) / 180;
  return { dx: Math.sin(rad) * stepM, dy: Math.cos(rad) * stepM };
}

// ── Повышение точности PDR ─────────────────────────────────────────────────────────

// Динамическая длина шага (модель Вайнберга): l = k · (a_max − a_min)^(1/4), где
// (a_max − a_min) — размах вертикального ускорения за шаг (в g). Длина шага зависит
// от человека и темпа — точнее фиксированной STEP_LENGTH_M. Результат ограничен
// разумным диапазоном шага человека.
export const WEINBERG_K = 0.5;
export function weinbergStepLength(accelPeakToPeakG: number, k: number = WEINBERG_K): number {
  if (!Number.isFinite(accelPeakToPeakG)) return 0.3; // битый замер → минимальный шаг
  const pp = Math.max(0, accelPeakToPeakG);
  const l = k * Math.pow(pp, 0.25);
  return Math.min(1.2, Math.max(0.3, l));
}

// Детектор шагов по модулю ускорения |a| (в g). OS-шагомер отдаёт только СЧЁТ и
// пакетами (несколько шагов за один колбэк), поэтому длину КАЖДОГО шага оцениваем
// сами: ловим пик |a| над динамическим средним и на спаде регистрируем шаг, возвращая
// его ПЕРСОНАЛЬНУЮ длину (Вайнберг по размаху именно этого шага). Рефрактерный период
// гасит дребезг/двойные срабатывания. Состояние — в замыкании; тестируется прогоном
// синтетического сигнала (navigatorMath.test.ts).
export const STEP_MIN_INTERVAL_MS = 250; // не быстрее ~4 шаг/с
export const STEP_ACCEL_THRESHOLD_G = 0.08; // порог над динамическим средним |a|
export const STEP_DETECT_EMA = 0.1; // EMA динамического среднего |a|

export interface StepDetector {
  // Принять замер |a| (g) с меткой времени (мс); вернуть длину шага (м) при детекте,
  // иначе null.
  update(magG: number, tMs: number): number | null;
}

export function createStepDetector(
  k: number = WEINBERG_K,
  minIntervalMs: number = STEP_MIN_INTERVAL_MS,
  thresholdG: number = STEP_ACCEL_THRESHOLD_G,
): StepDetector {
  let mean = 0; // EMA модуля |a| (≈ гравитация + медленный дрейф)
  let above = false; // фаза «над порогом» (внутри пика)
  let primed = false; // первый пик только калибрует тайминг, шаг не выдаёт (отсев прогрева)
  let lastStepMs = -Infinity;
  let winMin = Infinity; // размах |a| за текущий шаг
  let winMax = -Infinity;
  return {
    update(magG: number, tMs: number): number | null {
      if (!Number.isFinite(magG) || !Number.isFinite(tMs)) return null;
      mean = mean <= 0 ? magG : mean * (1 - STEP_DETECT_EMA) + magG * STEP_DETECT_EMA;
      if (magG < winMin) winMin = magG;
      if (magG > winMax) winMax = magG;
      if (magG > mean + thresholdG) {
        above = true;
        return null;
      }
      if (!above) return null; // спокойная фаза — ждём следующий пик
      above = false; // спад ниже порога после пика → конец шага
      let stepLen: number | null = null;
      if (primed && tMs - lastStepMs >= minIntervalMs) {
        const pp = winMax > winMin ? winMax - winMin : 0;
        stepLen = weinbergStepLength(pp, k);
        lastStepMs = tMs;
      } else if (!primed) {
        primed = true;
        lastStepMs = tMs;
      }
      winMin = Infinity;
      winMax = -Infinity;
      return stepLen;
    },
  };
}

// Комплементарный фильтр курса: гироскоп даёт гладкое короткоживущее приращение
// (gyroRateZ — угловая скорость вокруг вертикали, рад/с; интегрируем по dt), а
// магнитометр медленно (доля alpha) правит накопленный дрейф гироскопа. Знак
// gyroRateZ должен быть согласован с курсом (по часовой +) на стороне вызова.
export const HEADING_FUSE_ALPHA = 0.02;
export function fuseHeadingComplementary(
  prevDeg: number,
  gyroRateZ: number,
  dtSec: number,
  magHeadingDeg: number,
  alpha: number = HEADING_FUSE_ALPHA,
): number {
  // Битый замер гироскопа/курса — не порти накопленный курс.
  if (!Number.isFinite(gyroRateZ) || !Number.isFinite(dtSec)) return prevDeg;
  const predicted = prevDeg + (gyroRateZ * dtSec * 180) / Math.PI;
  const norm = normalizeDeg(predicted);
  if (!Number.isFinite(magHeadingDeg)) return norm; // нет магнитной цели — чистый гироскоп
  return smoothHeading(norm, magHeadingDeg, alpha); // медленная коррекция по кратчайшей дуге
}

export function magnitude3(x: number, y: number, z: number): number {
  return Math.hypot(x, y, z);
}

// Отсев магнитных аномалий: рядом с металлом модуль магнитного поля уходит от нормы.
// Если |m| отклонился от базовой линии больше, чем на долю tol — замер недостоверен
// (курс по нему обновлять не стоит). baseline<=0 — линия ещё не набрана, не отсекаем.
export function isMagneticAnomaly(mag: number, baseline: number, tol: number = 0.3): boolean {
  if (!Number.isFinite(mag)) return true; // битый замер — недостоверен (НЕ доверять)
  if (baseline <= 0) return false;
  return Math.abs(mag - baseline) / baseline > tol;
}

// ── Парсинг QR-якоря ──────────────────────────────────────────────────────────────
// Формат СТРОГО: SSNAV1|<warehouseId>|<xM>|<yM>|<headingDeg>.
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function parseAnchor(raw: string): NavAnchor | null {
  const parts = raw.trim().split('|');
  if (parts.length !== 5) return null;
  const [prefix, warehouseId, xs, ys, hs] = parts;
  if (prefix !== 'SSNAV1') return null;
  if (warehouseId === undefined || !UUID_RE.test(warehouseId)) return null;
  const xM = Number(xs);
  const yM = Number(ys);
  const headingDeg = Number(hs);
  if (!Number.isFinite(xM) || !Number.isFinite(yM) || !Number.isFinite(headingDeg)) {
    return null;
  }
  return { warehouseId, xM, yM, headingDeg };
}

// ── Геометрия маршрута ──────────────────────────────────────────────────────────────
export interface RouteInfo {
  distanceM: number;
  // Угол к цели относительно текущего heading: -180..180, + = направо.
  relativeDeg: number;
  turnText: string;
}

export function computeRoute(
  anchor: NavAnchor,
  target: { posXM: number; posYM: number },
): RouteInfo {
  const dx = target.posXM - anchor.xM;
  const dy = target.posYM - anchor.yM;
  const distanceM = Math.sqrt(dx * dx + dy * dy);
  // Абсолютный азимут к цели (0° = +Y вверх, по часовой).
  const targetDeg = (Math.atan2(dx, dy) * 180) / Math.PI; // atan2(восток, север)
  // Угол к цели относительно курса, приведённый к (-180, 180].
  const rel = signedDeltaDeg(targetDeg - anchor.headingDeg);
  let turnText: string;
  const a = Math.abs(rel);
  if (a < 15) turnText = 'Идите прямо';
  else if (a > 165) turnText = 'Развернитесь назад';
  else if (rel > 0) turnText = a > 60 ? 'Поверните направо' : 'Возьмите правее';
  else turnText = a > 60 ? 'Поверните налево' : 'Возьмите левее';
  return { distanceM, relativeDeg: rel, turnText };
}

// ── Выбор целевой ячейки ──────────────────────────────────────────────────────────
export type MappedCell = ProductLocation & { posXM: number; posYM: number };

// Размеченные ячейки (с координатами) + ближайшая к позе — ОБЩАЯ цель маршрута для
// AR- и PDR-навигатора, чтобы они не расходились в выборе ячейки для одного товара.
export function nearestMappedCell(
  pose: { xM: number; yM: number } | null,
  locations: ProductLocation[],
): { mapped: MappedCell[]; target: MappedCell | null } {
  const mapped = locations.filter(
    (l): l is MappedCell => l.posXM !== null && l.posYM !== null,
  );
  const first = mapped[0];
  if (!pose || first === undefined) return { mapped, target: null };
  let target: MappedCell = first;
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of mapped) {
    const dx = c.posXM - pose.xM;
    const dy = c.posYM - pose.yM;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      target = c;
    }
  }
  return { mapped, target };
}
