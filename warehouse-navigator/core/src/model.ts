// Модель данных навигатора по складу — МИНИМАЛЬНАЯ: только склад, ячейки, товар,
// размещение товара и QR-якорь. Без БД и фреймворков: чистые типы, общие для
// мобильного приложения (APK), Qt-десктопа и сервера. Координаты — в метрах, X
// вправо (восток), Y вверх (север); headingDeg — азимут 0° = север, по часовой.

// Склад.
export interface Warehouse {
  id: string;
  name: string;
}

// Ячейка хранения. posXM/posYM — точка ячейки на плане склада (метры) или null,
// если ячейка ещё не размечена на карте (тогда навигатор покажет только код).
export interface Cell {
  id: string;
  code: string;
  warehouseId: string;
  posXM: number | null;
  posYM: number | null;
}

// Товар. Сопоставление с ячейками — по barcode (как в исходном проекте) или по id.
export interface Product {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
}

// Где лежит товар: ячейка (с координатами) и количество. Цель навигации.
export interface ProductLocation {
  cellId: string;
  code: string;
  posXM: number | null;
  posYM: number | null;
  quantity: number;
}

// Размещение: сколько единиц товара лежит в ячейке (связь товар↔ячейка). На его
// основе строится ProductLocation (цель навигации).
export interface Placement {
  productId: string;
  cellId: string;
  quantity: number;
}

// QR-якорь «ВЫ ЗДЕСЬ»: позиция (м) + направление взгляда (headingDeg). Формат строки
// QR — SSNAV1|<warehouseId>|<xM>|<yM>|<headingDeg> (см. math/navigatorMath.parseAnchor).
export interface NavAnchor {
  warehouseId: string;
  xM: number;
  yM: number;
  headingDeg: number;
}

// Элемент плана склада для map-matching: стеллаж/стена (препятствие) либо
// зона/проход/дверь (проходимо). Центр (xM,yM), габариты (lengthM вдоль локальной X,
// widthM вдоль локальной Y), поворот. Совпадает с math/navigatorMapMatch.MapRect.
export interface LayoutRect {
  xM: number;
  yM: number;
  lengthM: number;
  widthM: number;
  rotationDeg?: number;
  kind?: 'rack' | 'wall' | 'door' | 'passage' | 'zone';
}
