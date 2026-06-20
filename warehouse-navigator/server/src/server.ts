// Крошечный LAN REST-сервер навигатора. Только node:http (без фреймворков) поверх
// WarehouseStore из ядра. Отдаёт телефону склады/ячейки/товары/где-лежит/план/якоря,
// принимает и отдаёт офлайн-снимок. CORS открыт — телефон ходит с другого origin по
// локальной сети. Только ЧТЕНИЕ данных навигации + загрузка снимка (POST /api/snapshot).

import http from 'node:http';
import { URL } from 'node:url';
import {
  type WarehouseStore,
  InMemoryWarehouseStore,
  parseSnapshot,
  serializeSnapshot,
} from '@smartstack/warehouse-navigator-core';

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(text);
}

async function readBody(req: http.IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('Тело запроса слишком большое');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Создаёт HTTP-сервер навигатора поверх произвольного хранилища. Если хранилище —
// InMemoryWarehouseStore, доступны загрузка/выгрузка снимка.
export function createNavServer(store: WarehouseStore): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res, store).catch((e) => {
      send(res, 500, { error: 'InternalError', message: (e as Error).message });
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: WarehouseStore,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'OPTIONS') return send(res, 204, '');

  const url = new URL(req.url ?? '/', 'http://localhost');
  const seg = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean); // ['api','warehouses',...]
  const q = url.searchParams;

  // GET /api/health
  if (method === 'GET' && seg.length === 1 && seg[0] === 'api') return send(res, 200, { ok: true });
  if (seg[0] !== 'api') return send(res, 404, { error: 'NotFound' });

  // GET /api/warehouses
  if (method === 'GET' && seg.length === 2 && seg[1] === 'warehouses') {
    return send(res, 200, { warehouses: await store.listWarehouses() });
  }

  // GET /api/products?search=
  if (method === 'GET' && seg.length === 2 && seg[1] === 'products') {
    return send(res, 200, { products: await store.listProducts(q.get('search') ?? undefined) });
  }

  // POST /api/snapshot  (загрузить снимок в InMemory-хранилище)
  if (method === 'POST' && seg.length === 2 && seg[1] === 'snapshot') {
    if (!(store instanceof InMemoryWarehouseStore)) {
      return send(res, 405, { error: 'NotSupported', message: 'Хранилище только для чтения' });
    }
    try {
      const snap = parseSnapshot(await readBody(req));
      store.loadSnapshot(snap);
      return send(res, 200, { ok: true, warehouseId: snap.warehouse.id });
    } catch (e) {
      return send(res, 400, { error: 'BadSnapshot', message: (e as Error).message });
    }
  }

  // /api/warehouses/:id/...
  if (seg.length >= 4 && seg[1] === 'warehouses') {
    const wid = seg[2] as string;
    const sub = seg[3];
    if (method === 'GET' && sub === 'cells') {
      return send(res, 200, { cells: await store.listCells(wid) });
    }
    if (method === 'GET' && sub === 'layout') {
      return send(res, 200, { layout: { racks: await store.layout(wid) } });
    }
    if (method === 'GET' && sub === 'anchors') {
      return send(res, 200, { anchors: await store.listAnchors(wid) });
    }
    if (method === 'GET' && sub === 'product-location') {
      const productId = q.get('productId');
      if (!productId) return send(res, 400, { error: 'BadRequest', message: 'productId обязателен' });
      return send(res, 200, { locations: await store.productLocation(wid, productId) });
    }
    if (method === 'GET' && sub === 'snapshot') {
      if (!(store instanceof InMemoryWarehouseStore)) {
        return send(res, 405, { error: 'NotSupported' });
      }
      const snap = store.exportSnapshot(wid);
      if (!snap) return send(res, 404, { error: 'NotFound', message: 'Склад не найден' });
      return send(res, 200, serializeSnapshot(snap, false));
    }
  }

  return send(res, 404, { error: 'NotFound' });
}
