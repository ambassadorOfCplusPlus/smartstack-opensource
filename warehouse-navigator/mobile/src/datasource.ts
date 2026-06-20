// Источник данных навигатора: одинаковый интерфейс для ЖИВОГО режима (LAN REST к
// серверу) и ОФЛАЙН-режима (импортированный снимок, читается ядром в памяти). Экран
// навигатора не знает, откуда данные.

import {
  InMemoryWarehouseStore,
  parseSnapshot,
  type Product,
  type ProductLocation,
  type LayoutRect,
} from '@smartstack/warehouse-navigator-core';

export interface NavDataSource {
  searchProducts(q: string): Promise<Product[]>;
  productLocation(warehouseId: string, productId: string): Promise<ProductLocation[]>;
  layout(warehouseId: string): Promise<LayoutRect[]>;
}

// ЖИВОЙ режим: HTTP к LAN-серверу (см. ../server). baseUrl вида http://192.168.x.x:8088.
export class RemoteSource implements NavDataSource {
  constructor(private readonly baseUrl: string) {}

  private async get<T>(path: string): Promise<T> {
    const r = await fetch(`${this.baseUrl}${path}`);
    if (!r.ok) throw new Error(`Сервер ответил ${r.status}`);
    return (await r.json()) as T;
  }

  async searchProducts(q: string): Promise<Product[]> {
    const d = await this.get<{ products: Product[] }>(
      `/api/products?search=${encodeURIComponent(q)}`,
    );
    return d.products;
  }

  async productLocation(warehouseId: string, productId: string): Promise<ProductLocation[]> {
    const d = await this.get<{ locations: ProductLocation[] }>(
      `/api/warehouses/${encodeURIComponent(warehouseId)}/product-location?productId=${encodeURIComponent(productId)}`,
    );
    return d.locations;
  }

  async layout(warehouseId: string): Promise<LayoutRect[]> {
    const d = await this.get<{ layout: { racks: LayoutRect[] } }>(
      `/api/warehouses/${encodeURIComponent(warehouseId)}/layout`,
    );
    return d.layout?.racks ?? [];
  }

  // Проверка связи перед входом в навигатор.
  async ping(): Promise<boolean> {
    try {
      await this.get<{ ok: boolean }>('/api');
      return true;
    } catch {
      return false;
    }
  }
}

// ОФЛАЙН режим: снимок склада (файл *.whnav.json) читается ядром, дальше всё локально.
export class OfflineSource implements NavDataSource {
  private readonly store = new InMemoryWarehouseStore();

  constructor(snapshotText: string) {
    this.store.loadSnapshot(parseSnapshot(snapshotText)); // бросит SnapshotError на битом файле
  }

  searchProducts(q: string): Promise<Product[]> {
    return this.store.listProducts(q);
  }
  productLocation(warehouseId: string, productId: string): Promise<ProductLocation[]> {
    return this.store.productLocation(warehouseId, productId);
  }
  layout(warehouseId: string): Promise<LayoutRect[]> {
    return this.store.layout(warehouseId);
  }
}
