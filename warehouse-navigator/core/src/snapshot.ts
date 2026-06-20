// Кодек офлайн-снимка склада: ПК-клиент экспортирует склад в файл (.whnav.json),
// телефон импортирует и навигирует без сети. Чистый JSON + строгая валидация на
// входе (чужой/битый файл → понятная ошибка, а не падение навигатора).

import type { WarehouseSnapshot } from './store.js';

export const SNAPSHOT_VERSION = 1 as const;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// Сериализация снимка в строку файла. pretty=false — компактно (для QR/передачи).
export function serializeSnapshot(s: WarehouseSnapshot, pretty = true): string {
  return JSON.stringify(s, null, pretty ? 2 : 0);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function str(v: unknown): v is string {
  return typeof v === 'string';
}
function numOrNull(v: unknown): v is number | null {
  return v === null || num(v);
}

// Разбор и ВАЛИДАЦИЯ строки файла в снимок. Бросает SnapshotError при любой
// несостыковке схемы — навигатор должен отклонить чужой файл, а не работать наугад.
export function parseSnapshot(text: string): WarehouseSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('Файл не является корректным JSON');
  }
  if (!isObject(raw)) throw new SnapshotError('Ожидался объект снимка');
  if (raw.version !== SNAPSHOT_VERSION) {
    throw new SnapshotError(`Неподдерживаемая версия снимка: ${String(raw.version)}`);
  }
  if (!isObject(raw.warehouse) || !str(raw.warehouse.id) || !str(raw.warehouse.name)) {
    throw new SnapshotError('Некорректный склад в снимке');
  }
  const arr = (v: unknown, field: string): unknown[] => {
    if (!Array.isArray(v)) throw new SnapshotError(`Поле «${field}» должно быть массивом`);
    return v;
  };
  const wid = raw.warehouse.id;

  const cells = arr(raw.cells, 'cells').map((c, i) => {
    if (!isObject(c) || !str(c.id) || !str(c.code) || !str(c.warehouseId))
      throw new SnapshotError(`Некорректная ячейка #${i}`);
    if (c.warehouseId !== wid)
      throw new SnapshotError(`Ячейка #${i} принадлежит другому складу`); // иначе молча терялась бы
    if (!numOrNull(c.posXM) || !numOrNull(c.posYM))
      throw new SnapshotError(`Некорректные координаты ячейки #${i}`);
    return {
      id: c.id,
      code: c.code,
      warehouseId: c.warehouseId,
      posXM: c.posXM as number | null,
      posYM: c.posYM as number | null,
    };
  });

  const products = arr(raw.products, 'products').map((p, i) => {
    if (!isObject(p) || !str(p.id) || !str(p.sku) || !str(p.name))
      throw new SnapshotError(`Некорректный товар #${i}`);
    if (!(p.barcode === null || str(p.barcode)))
      throw new SnapshotError(`Некорректный штрихкод товара #${i}`);
    return { id: p.id, sku: p.sku, name: p.name, barcode: (p.barcode ?? null) as string | null };
  });

  const placements = arr(raw.placements, 'placements').map((pl, i) => {
    if (!isObject(pl) || !str(pl.productId) || !str(pl.cellId) || !num(pl.quantity))
      throw new SnapshotError(`Некорректное размещение #${i}`);
    if (pl.quantity < 0) throw new SnapshotError(`Отрицательное количество в размещении #${i}`);
    return { productId: pl.productId, cellId: pl.cellId, quantity: pl.quantity };
  });

  const layout = arr(raw.layout, 'layout').map((r, i) => {
    if (!isObject(r) || !num(r.xM) || !num(r.yM) || !num(r.lengthM) || !num(r.widthM))
      throw new SnapshotError(`Некорректный элемент плана #${i}`);
    return {
      xM: r.xM,
      yM: r.yM,
      lengthM: r.lengthM,
      widthM: r.widthM,
      rotationDeg: num(r.rotationDeg) ? r.rotationDeg : 0,
      kind: str(r.kind) ? (r.kind as WarehouseSnapshot['layout'][number]['kind']) : 'rack',
    };
  });

  const anchors = arr(raw.anchors, 'anchors').map((a, i) => {
    if (!isObject(a) || !str(a.warehouseId) || !num(a.xM) || !num(a.yM) || !num(a.headingDeg))
      throw new SnapshotError(`Некорректный якорь #${i}`);
    return { warehouseId: a.warehouseId, xM: a.xM, yM: a.yM, headingDeg: a.headingDeg };
  });

  return {
    version: SNAPSHOT_VERSION,
    warehouse: { id: wid, name: raw.warehouse.name },
    cells,
    products,
    placements,
    layout,
    anchors,
  };
}
