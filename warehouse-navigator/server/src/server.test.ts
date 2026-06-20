import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  InMemoryWarehouseStore,
  serializeSnapshot,
  type WarehouseSnapshot,
} from '@smartstack/warehouse-navigator-core';
import { createNavServer } from './server.ts';

const snap: WarehouseSnapshot = {
  version: 1,
  warehouse: { id: 'wh1', name: 'Склад' },
  cells: [{ id: 'c1', code: 'A-01', warehouseId: 'wh1', posXM: 1, posYM: 2 }],
  products: [{ id: 'p1', sku: 'S1', name: 'Гайка', barcode: '460' }],
  placements: [{ productId: 'p1', cellId: 'c1', quantity: 7 }],
  layout: [{ xM: 5, yM: 5, lengthM: 4, widthM: 2, rotationDeg: 0, kind: 'rack' }],
  anchors: [{ warehouseId: 'wh1', xM: 0, yM: 0, headingDeg: 90 }],
};

let server: Server;
let base: string;

// Хелпер: тело ответа как any (тесты не типизируют JSON построчно).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<any> => r.json();

beforeAll(async () => {
  const store = new InMemoryWarehouseStore();
  store.loadSnapshot(snap);
  server = createNavServer(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

describe('createNavServer', () => {
  it('GET /api → health', async () => {
    const r = await fetch(`${base}/api`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('GET /api/warehouses', async () => {
    const r = await fetch(`${base}/api/warehouses`);
    expect((await body(r)).warehouses).toEqual([{ id: 'wh1', name: 'Склад' }]);
  });

  it('GET /api/products?search=', async () => {
    const r = await fetch(`${base}/api/products?search=гай`);
    expect((await body(r)).products.map((p: { id: string }) => p.id)).toEqual(['p1']);
  });

  it('GET product-location агрегирует и даёт координаты', async () => {
    const r = await fetch(`${base}/api/warehouses/wh1/product-location?productId=p1`);
    const { locations } = await body(r);
    expect(locations).toEqual([
      { cellId: 'c1', code: 'A-01', posXM: 1, posYM: 2, quantity: 7 },
    ]);
  });

  it('GET product-location без productId → 400', async () => {
    const r = await fetch(`${base}/api/warehouses/wh1/product-location`);
    expect(r.status).toBe(400);
  });

  it('GET layout в форме { layout: { racks } } (как ждёт мобильный клиент)', async () => {
    const r = await fetch(`${base}/api/warehouses/wh1/layout`);
    const b = await body(r);
    expect(b.layout.racks).toHaveLength(1);
    expect(b.layout.racks[0].kind).toBe('rack');
  });

  it('GET anchors', async () => {
    const r = await fetch(`${base}/api/warehouses/wh1/anchors`);
    expect((await body(r)).anchors[0].headingDeg).toBe(90);
  });

  it('GET snapshot → round-trip совместим с офлайн-форматом', async () => {
    const r = await fetch(`${base}/api/warehouses/wh1/snapshot`);
    const text = await r.text();
    expect(JSON.parse(text).warehouse.id).toBe('wh1');
  });

  it('POST /api/snapshot загружает новый склад', async () => {
    const snap2: WarehouseSnapshot = {
      ...snap,
      warehouse: { id: 'wh2', name: 'Второй' },
      cells: [{ id: 'c9', code: 'Z-01', warehouseId: 'wh2', posXM: 0, posYM: 0 }],
      placements: [],
    };
    const r = await fetch(`${base}/api/snapshot`, {
      method: 'POST',
      body: serializeSnapshot(snap2),
    });
    expect(r.status).toBe(200);
    const list = await body(await fetch(`${base}/api/warehouses`));
    expect(list.warehouses.map((w: { id: string }) => w.id).sort()).toEqual(['wh1', 'wh2']);
  });

  it('POST /api/snapshot с мусором → 400', async () => {
    const r = await fetch(`${base}/api/snapshot`, { method: 'POST', body: '{битый' });
    expect(r.status).toBe(400);
  });

  it('неизвестный путь → 404', async () => {
    const r = await fetch(`${base}/api/nope`);
    expect(r.status).toBe(404);
  });

  it('CORS-префлайт OPTIONS → 204', async () => {
    const r = await fetch(`${base}/api/warehouses`, { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });
});
