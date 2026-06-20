// Хранилище склада — storage-agnostic интерфейс (как BatchStore в writeoff-engine):
// навигатору и серверу всё равно, где лежат данные (SQLite/PostgreSQL/файл/память).
// Плюс эталонная реализация в памяти (InMemoryWarehouseStore) — для тестов, демо и
// офлайн-режима (загрузить снапшот → читать как обычный склад).

import type {
  Warehouse,
  Cell,
  Product,
  Placement,
  ProductLocation,
  NavAnchor,
  LayoutRect,
} from './model.js';

// Чтение, достаточное для навигатора, + минимальные записи для ПК-клиента.
export interface WarehouseStore {
  listWarehouses(): Promise<Warehouse[]>;
  listCells(warehouseId: string): Promise<Cell[]>;
  // Поиск товара по подстроке (имя/sku/штрихкод); без аргумента — все.
  listProducts(search?: string): Promise<Product[]>;
  // Где лежит товар: ячейки с координатами и количеством (цель навигации).
  productLocation(warehouseId: string, productId: string): Promise<ProductLocation[]>;
  // План склада (стеллажи/стены/зоны) для map-matching.
  layout(warehouseId: string): Promise<LayoutRect[]>;
  // QR-якоря склада (для ПК-клиента — печать; навигатор обычно читает их с камеры).
  listAnchors(warehouseId: string): Promise<NavAnchor[]>;
}

// Полный снимок данных одного склада — единица обмена между ПК-клиентом и телефоном
// в ОФЛАЙН-режиме (экспорт файлом). Версия — для будущей совместимости.
export interface WarehouseSnapshot {
  version: 1;
  warehouse: Warehouse;
  cells: Cell[];
  products: Product[];
  placements: Placement[];
  layout: LayoutRect[];
  anchors: NavAnchor[];
}

function matchesProduct(p: Product, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (s === '') return true;
  return (
    p.name.toLowerCase().includes(s) ||
    p.sku.toLowerCase().includes(s) ||
    (p.barcode ?? '').toLowerCase().includes(s)
  );
}

// Эталонное хранилище в памяти. Принимает снимок (или пустой склад) и отвечает на
// запросы навигатора. productLocation агрегирует размещения по ячейке и подставляет
// её координаты с плана. НЕ потокобезопасно — это простая ссылочная реализация.
export class InMemoryWarehouseStore implements WarehouseStore {
  private readonly warehouses = new Map<string, Warehouse>();
  private readonly cells = new Map<string, Cell[]>(); // warehouseId → cells
  private readonly products = new Map<string, Product>();
  private placements: Placement[] = [];
  private readonly layouts = new Map<string, LayoutRect[]>(); // warehouseId → rects
  private readonly anchors = new Map<string, NavAnchor[]>(); // warehouseId → anchors

  // Загрузить (или дозагрузить) снимок склада. Повторная загрузка того же склада
  // заменяет его данные.
  loadSnapshot(s: WarehouseSnapshot): void {
    this.warehouses.set(s.warehouse.id, s.warehouse);
    this.cells.set(
      s.warehouse.id,
      s.cells.filter((c) => c.warehouseId === s.warehouse.id),
    );
    this.layouts.set(s.warehouse.id, s.layout);
    this.anchors.set(s.warehouse.id, s.anchors);
    for (const p of s.products) this.products.set(p.id, p);
    // Размещения других складов сохраняем, этого — заменяем.
    const cellIds = new Set(this.cells.get(s.warehouse.id)?.map((c) => c.id));
    this.placements = this.placements
      .filter((pl) => !cellIds.has(pl.cellId))
      .concat(s.placements);
  }

  async listWarehouses(): Promise<Warehouse[]> {
    return [...this.warehouses.values()];
  }

  async listCells(warehouseId: string): Promise<Cell[]> {
    return this.cells.get(warehouseId) ?? [];
  }

  async listProducts(search?: string): Promise<Product[]> {
    const q = search ?? '';
    return [...this.products.values()].filter((p) => matchesProduct(p, q));
  }

  async productLocation(warehouseId: string, productId: string): Promise<ProductLocation[]> {
    const cells = this.cells.get(warehouseId) ?? [];
    const cellById = new Map(cells.map((c) => [c.id, c]));
    const byCell = new Map<string, ProductLocation>();
    for (const pl of this.placements) {
      if (pl.productId !== productId || pl.quantity <= 0) continue;
      const cell = cellById.get(pl.cellId);
      if (!cell) continue; // ячейка не этого склада
      const existing = byCell.get(cell.id);
      if (existing) {
        existing.quantity += pl.quantity;
      } else {
        byCell.set(cell.id, {
          cellId: cell.id,
          code: cell.code,
          posXM: cell.posXM,
          posYM: cell.posYM,
          quantity: pl.quantity,
        });
      }
    }
    return [...byCell.values()];
  }

  async layout(warehouseId: string): Promise<LayoutRect[]> {
    return this.layouts.get(warehouseId) ?? [];
  }

  async listAnchors(warehouseId: string): Promise<NavAnchor[]> {
    return this.anchors.get(warehouseId) ?? [];
  }

  // Собрать полный снимок склада обратно (для офлайн-экспорта телефону / резерва).
  exportSnapshot(warehouseId: string): WarehouseSnapshot | null {
    const warehouse = this.warehouses.get(warehouseId);
    if (!warehouse) return null;
    const cells = this.cells.get(warehouseId) ?? [];
    const cellIds = new Set(cells.map((c) => c.id));
    return {
      version: 1,
      warehouse,
      cells,
      products: [...this.products.values()],
      placements: this.placements.filter((p) => cellIds.has(p.cellId)),
      layout: this.layouts.get(warehouseId) ?? [],
      anchors: this.anchors.get(warehouseId) ?? [],
    };
  }
}
