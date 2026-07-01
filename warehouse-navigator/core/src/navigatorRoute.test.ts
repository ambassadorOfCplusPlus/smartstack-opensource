import { describe, it, expect } from 'vitest';
import {
  buildPickItems,
  orderStopsNearest,
  routeTotalM,
  type PickItem,
  type ProductWithLocations,
} from './navigatorRoute';

// Хелпер: локация ячейки (совместима с ProductLocation).
const loc = (cellId: string, posXM: number | null, posYM: number | null) => ({
  cellId,
  code: cellId,
  posXM,
  posYM,
  quantity: 1,
});

// Хелпер: остановка pick-list в размеченной ячейке (x,y).
const pick = (id: string, x: number, y: number): PickItem => ({
  productId: id,
  productName: id,
  cell: { cellId: id, code: id, posXM: x, posYM: y, quantity: 1 },
});

describe('buildPickItems', () => {
  const start = { xM: 0, yM: 0 };
  it('берёт для каждого товара ближайшую размеченную ячейку', () => {
    const items: ProductWithLocations[] = [
      { productId: 'p1', productName: 'Товар 1', locations: [loc('A', 10, 0), loc('B', 2, 0)] },
    ];
    const { picks, unmapped } = buildPickItems(start, items);
    expect(unmapped).toHaveLength(0);
    expect(picks).toHaveLength(1);
    expect(picks[0]!.cell.cellId).toBe('B'); // ближе к старту
  });
  it('товар без координат на карте уходит в unmapped, а не в маршрут', () => {
    const items: ProductWithLocations[] = [
      { productId: 'p1', productName: 'Размеченный', locations: [loc('A', 5, 5)] },
      { productId: 'p2', productName: 'Без карты', locations: [loc('X', null, null)] },
    ];
    const { picks, unmapped } = buildPickItems(start, items);
    expect(picks.map((p) => p.productId)).toEqual(['p1']);
    expect(unmapped).toEqual(['Без карты']);
  });
  it('пустой список товаров → пустой pick-list', () => {
    const { picks, unmapped } = buildPickItems(start, []);
    expect(picks).toHaveLength(0);
    expect(unmapped).toHaveLength(0);
  });
});

describe('orderStopsNearest', () => {
  const start = { xM: 0, yM: 0 };
  it('жадный «ближайший сосед»: ближняя цель — первой', () => {
    // Точки на оси X: 1, 5, 3, 10 → обход 1,3,5,10.
    const stops = [pick('far', 10, 0), pick('near', 1, 0), pick('mid', 5, 0), pick('m2', 3, 0)];
    const ordered = orderStopsNearest(start, stops);
    expect(ordered.map((s) => s.productId)).toEqual(['near', 'm2', 'mid', 'far']);
  });
  it('старт смещает выбор ближайшего (не абсолютный порядок)', () => {
    // Старт у дальней точки: обход должен начаться с неё.
    const stops = [pick('a', 0, 0), pick('b', 10, 0), pick('c', 20, 0)];
    const ordered = orderStopsNearest({ xM: 21, yM: 0 }, stops);
    expect(ordered.map((s) => s.productId)).toEqual(['c', 'b', 'a']);
  });
  it('не мутирует входной массив остановок', () => {
    const stops = [pick('a', 3, 0), pick('b', 1, 0)];
    const before = stops.map((s) => s.productId);
    orderStopsNearest(start, stops);
    expect(stops.map((s) => s.productId)).toEqual(before);
  });
  it('вырожденные случаи: 0 и 1 точка', () => {
    expect(orderStopsNearest(start, [])).toEqual([]);
    const one = [pick('solo', 4, 4)];
    expect(orderStopsNearest(start, one).map((s) => s.productId)).toEqual(['solo']);
  });
});

describe('routeTotalM', () => {
  const start = { xM: 0, yM: 0 };
  it('суммарная длина обхода старт → стопы по порядку', () => {
    // 0→(3,4)=5, (3,4)→(3,4+12)=12 → 17.
    const ordered = [pick('a', 3, 4), pick('b', 3, 16)];
    expect(routeTotalM(start, ordered)).toBeCloseTo(17, 6);
  });
  it('порядок влияет на длину; жадный обход не длиннее «как пришло»', () => {
    const stops = [pick('far', 10, 0), pick('near', 1, 0), pick('mid', 5, 0)];
    const greedy = routeTotalM(start, orderStopsNearest(start, stops));
    const asIs = routeTotalM(start, stops);
    expect(greedy).toBeLessThanOrEqual(asIs);
    expect(greedy).toBeCloseTo(10, 6); // 0→1→5→10, всё по оси X
  });
  it('вырожденные случаи: 0 стопов → 0; 1 стоп → расстояние до него', () => {
    expect(routeTotalM(start, [])).toBe(0);
    expect(routeTotalM(start, [pick('solo', 3, 4)])).toBeCloseTo(5, 6);
  });
});
