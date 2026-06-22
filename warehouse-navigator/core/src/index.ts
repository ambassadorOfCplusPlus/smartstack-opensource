// Публичный API ядра навигатора по складу. Чистый TypeScript без зависимостей —
// одинаково годится мобильному приложению (APK), Qt-десктопу (через порт логики) и
// серверу.

export * from './model.js';
export * from './store.js';
export * from './snapshot.js';

// Математика навигатора.
export * from './math/navigatorMath.js'; // курс, PDR, Вайнберг, детектор шагов, маршрут, парсинг якоря, normalizeDeg
export * from './math/navigatorMapMatch.js'; // map-matching по плану склада
export * from './math/navigatorGuidance.js'; // выправление стрелки по плану (обход стен/стеллажей)
export * from './math/navigatorFusion.js'; // оптическо-инерциальная фузия (оптика выправляет дрейф PDR)
// navigatorAr реэкспортит normalizeDeg из navigatorMath — берём из него остальное
// явно, чтобы не задвоить normalizeDeg в бочке-реэкспорте.
export {
  groundHeadingDeg,
  makeArReference,
  arPose,
  warehouseToArGround,
  arTravelM,
} from './math/navigatorAr.js';
export type { ArSample, ArReference } from './math/navigatorAr.js';
