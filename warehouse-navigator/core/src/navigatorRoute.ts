// Маршрут по нескольким товарам (pick-list) для навигатора: обход сразу нескольких
// ячеек за один проход по складу. Ядро навигатора умеет вести к ОДНОЙ цели
// (nearestMappedCell + computeRoute/guidanceRoute); здесь строится УПОРЯДОЧЕННЫЙ
// список остановок и считается остаток пути. Чистая геометрия без React Native /
// Qt — покрыта юнит-тестами (navigatorRoute.test.ts).
//
// Подход «простой и устойчивый»: для каждого товара берём ближайшую к старту
// размеченную ячейку, затем строим обход жадным «ближайшим соседом». Порядок
// детерминирован и пересчитывается ТОЛЬКО по событиям (добавили/собрали товар,
// кнопка «пересчитать»), а не на каждый тик позы — чтобы навигатор не «дёргался».
import { nearestMappedCell, type MappedCell } from './math/navigatorMath.js';
import type { ProductLocation } from './model.js';

export interface PickItem {
  productId: string;
  productName: string;
  cell: MappedCell; // выбранная (ближайшая) ячейка товара
}

export interface ProductWithLocations {
  productId: string;
  productName: string;
  locations: ProductLocation[];
}

// Для каждого товара выбираем ближайшую к старту размеченную ячейку. Товары без
// координат на карте собираем в unmapped (их не ведём, но показываем пользователю).
export function buildPickItems(
  start: { xM: number; yM: number } | null,
  items: ProductWithLocations[],
): { picks: PickItem[]; unmapped: string[] } {
  const picks: PickItem[] = [];
  const unmapped: string[] = [];
  for (const it of items) {
    const { target } = nearestMappedCell(start, it.locations);
    if (target) {
      picks.push({ productId: it.productId, productName: it.productName, cell: target });
    } else {
      unmapped.push(it.productName);
    }
  }
  return { picks, unmapped };
}

// Жадный обход «ближайший сосед»: из текущей точки идём в ближайшую цель, затем из
// неё — в ближайшую из оставшихся. Простая и устойчивая эвристика (не оптимальный
// TSP, но детерминированная и предсказуемая для кладовщика).
export function orderStopsNearest(
  start: { xM: number; yM: number },
  stops: PickItem[],
): PickItem[] {
  const remaining = [...stops];
  const ordered: PickItem[] = [];
  let cur = { xM: start.xM, yM: start.yM };
  while (remaining.length > 0) {
    let bestI = 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const dx = remaining[i]!.cell.posXM - cur.xM;
      const dy = remaining[i]!.cell.posYM - cur.yM;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    const [next] = remaining.splice(bestI, 1);
    ordered.push(next!);
    cur = { xM: next!.cell.posXM, yM: next!.cell.posYM };
  }
  return ordered;
}

// Суммарная длина обхода (старт → стопы по порядку), метры — для подписи маршрута.
export function routeTotalM(
  start: { xM: number; yM: number },
  ordered: PickItem[],
): number {
  let total = 0;
  let cur = { xM: start.xM, yM: start.yM };
  for (const s of ordered) {
    total += Math.hypot(s.cell.posXM - cur.xM, s.cell.posYM - cur.yM);
    cur = { xM: s.cell.posXM, yM: s.cell.posYM };
  }
  return total;
}
