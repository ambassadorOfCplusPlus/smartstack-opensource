import { describe, it, expect } from 'vitest';
import { serializeSnapshot, parseSnapshot, SnapshotError } from './snapshot';
import type { WarehouseSnapshot } from './store';

const snap: WarehouseSnapshot = {
  version: 1,
  warehouse: { id: 'wh1', name: 'Склад' },
  cells: [{ id: 'c1', code: 'A-01', warehouseId: 'wh1', posXM: 1, posYM: 2 }],
  products: [{ id: 'p1', sku: 'S1', name: 'Товар', barcode: null }],
  placements: [{ productId: 'p1', cellId: 'c1', quantity: 4 }],
  layout: [{ xM: 5, yM: 5, lengthM: 4, widthM: 2, rotationDeg: 0, kind: 'rack' }],
  anchors: [{ warehouseId: 'wh1', xM: 0, yM: 0, headingDeg: 0 }],
};

describe('snapshot codec', () => {
  it('round-trip: serialize → parse возвращает эквивалент', () => {
    expect(parseSnapshot(serializeSnapshot(snap))).toEqual(snap);
  });

  it('не-JSON → SnapshotError', () => {
    expect(() => parseSnapshot('{не json')).toThrow(SnapshotError);
  });

  it('чужая версия → SnapshotError', () => {
    const bad = JSON.stringify({ ...snap, version: 99 });
    expect(() => parseSnapshot(bad)).toThrow(/версия/i);
  });

  it('битая ячейка (нечисловые координаты) → SnapshotError', () => {
    const bad = JSON.stringify({
      ...snap,
      cells: [{ id: 'c1', code: 'A', warehouseId: 'wh1', posXM: 'x', posYM: 2 }],
    });
    expect(() => parseSnapshot(bad)).toThrow(SnapshotError);
  });

  it('отсутствует массив products → SnapshotError', () => {
    const { products: _drop, ...rest } = snap;
    expect(() => parseSnapshot(JSON.stringify(rest))).toThrow(/products/);
  });

  it('пустой план/якоря — допустимо', () => {
    const empty = { ...snap, layout: [], anchors: [], placements: [] };
    expect(parseSnapshot(JSON.stringify(empty)).layout).toEqual([]);
  });
});
