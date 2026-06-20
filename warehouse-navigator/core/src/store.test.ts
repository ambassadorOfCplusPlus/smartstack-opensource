import { describe, it, expect } from 'vitest';
import { InMemoryWarehouseStore, type WarehouseSnapshot } from './store';

const snap: WarehouseSnapshot = {
  version: 1,
  warehouse: { id: 'wh1', name: 'Основной склад' },
  cells: [
    { id: 'c1', code: 'A-01', warehouseId: 'wh1', posXM: 1, posYM: 2 },
    { id: 'c2', code: 'A-02', warehouseId: 'wh1', posXM: 3, posYM: 4 },
    { id: 'c3', code: 'B-01', warehouseId: 'wh1', posXM: null, posYM: null },
  ],
  products: [
    { id: 'p1', sku: 'SKU1', name: 'Гайка М6', barcode: '4600000000017' },
    { id: 'p2', sku: 'SKU2', name: 'Болт М8', barcode: null },
  ],
  placements: [
    { productId: 'p1', cellId: 'c1', quantity: 5 },
    { productId: 'p1', cellId: 'c1', quantity: 3 }, // та же ячейка → суммируется
    { productId: 'p1', cellId: 'c2', quantity: 2 },
    { productId: 'p2', cellId: 'c3', quantity: 9 },
  ],
  layout: [{ xM: 5, yM: 5, lengthM: 4, widthM: 2, rotationDeg: 0, kind: 'rack' }],
  anchors: [{ warehouseId: 'wh1', xM: 0, yM: 0, headingDeg: 90 }],
};

describe('InMemoryWarehouseStore', () => {
  const store = new InMemoryWarehouseStore();
  store.loadSnapshot(snap);

  it('склады/ячейки/план/якоря читаются', async () => {
    expect((await store.listWarehouses()).map((w) => w.id)).toEqual(['wh1']);
    expect((await store.listCells('wh1')).length).toBe(3);
    expect((await store.layout('wh1')).length).toBe(1);
    expect((await store.listAnchors('wh1'))[0]?.headingDeg).toBe(90);
  });

  it('поиск товара по имени/sku/штрихкоду', async () => {
    expect((await store.listProducts('гайка')).map((p) => p.id)).toEqual(['p1']);
    expect((await store.listProducts('SKU2')).map((p) => p.id)).toEqual(['p2']);
    expect((await store.listProducts('460')).map((p) => p.id)).toEqual(['p1']);
    expect((await store.listProducts()).length).toBe(2);
  });

  it('productLocation агрегирует по ячейке и подставляет координаты', async () => {
    const locs = await store.productLocation('wh1', 'p1');
    const c1 = locs.find((l) => l.cellId === 'c1');
    const c2 = locs.find((l) => l.cellId === 'c2');
    expect(c1?.quantity).toBe(8); // 5 + 3
    expect(c1?.posXM).toBe(1);
    expect(c2?.quantity).toBe(2);
  });

  it('товар в неразмеченной ячейке → координаты null (навигатор покажет только код)', async () => {
    const locs = await store.productLocation('wh1', 'p2');
    expect(locs).toHaveLength(1);
    expect(locs[0]?.posXM).toBeNull();
  });

  it('неизвестный товар → пусто', async () => {
    expect(await store.productLocation('wh1', 'nope')).toEqual([]);
  });
});

describe('InMemoryWarehouseStore — изоляция складов', () => {
  it('перезагрузка склада заменяет его размещения (нет осиротевших)', async () => {
    const s = new InMemoryWarehouseStore();
    s.loadSnapshot(snap); // p1: c1=8, c2=2
    // Перезагружаем wh1 БЕЗ c2 и с единственным размещением на c1.
    s.loadSnapshot({
      ...snap,
      cells: snap.cells.filter((c) => c.id !== 'c2'),
      placements: [{ productId: 'p1', cellId: 'c1', quantity: 1 }],
    });
    const locs = await s.productLocation('wh1', 'p1');
    expect(locs.map((l) => l.cellId)).toEqual(['c1']);
    expect(locs[0]?.quantity).toBe(1); // старые 8/2 не «протекли»
  });

  it('склады с одинаковым id ячейки не затирают друг друга', async () => {
    const mk = (wid: string, qty: number): WarehouseSnapshot => ({
      version: 1,
      warehouse: { id: wid, name: wid },
      cells: [{ id: 'c1', code: 'X', warehouseId: wid, posXM: 0, posYM: 0 }],
      products: [{ id: 'p', sku: 'p', name: 'p', barcode: null }],
      placements: [{ productId: 'p', cellId: 'c1', quantity: qty }],
      layout: [],
      anchors: [],
    });
    const s = new InMemoryWarehouseStore();
    s.loadSnapshot(mk('whA', 5));
    s.loadSnapshot(mk('whB', 9));
    expect((await s.productLocation('whA', 'p'))[0]?.quantity).toBe(5);
    expect((await s.productLocation('whB', 'p'))[0]?.quantity).toBe(9);
  });
});
