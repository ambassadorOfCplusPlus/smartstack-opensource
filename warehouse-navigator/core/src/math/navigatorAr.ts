// Чистая математика привязки AR-мира (ARCore/ARKit через ViroReact) к системе
// координат склада. Без импортов ViroReact/RN — модуль покрыт юнит-тестами
// (navigatorAr.test.ts).
//
// Система AR-мира (гравитационно выровнена, yaw произвольный — задаётся в момент
// старта сессии): +x вправо, +y вверх, +z «из экрана» к пользователю. Камера в
// начале смотрит вдоль -z. На плоскости пола (x,z) вводим компасоподобные оси:
//   AR-«север» = -z,  AR-«восток» = +x.
// Это та же система отсчёта курса, что и у склада/магнитометра (0° = север/+Y по
// карте, по часовой), поэтому курсы и смещения переносятся напрямую поворотом на
// угол выравнивания align = (курс якоря) − (AR-курс камеры в момент скана).
import type { NavAnchor } from '../model.js';
// Каноничная нормализация угла живёт в navigatorMath (общая геометрия); реэкспорт
// сохраняет публичную точку входа этого модуля и его тесты.
import { normalizeDeg } from './navigatorMath.js';
export { normalizeDeg };

// Один замер позы из ViroARScene.onCameraTransformUpdate: позиция камеры (м) и
// её forward-вектор (оба — в AR-мире).
export interface ArSample {
  x: number;
  z: number;
  fx: number;
  fz: number;
}

// AR-референс, зафиксированный в момент скана QR-якоря: позиция камеры, её
// AR-курс и угол выравнивания AR-мира со складом.
export interface ArReference {
  x: number;
  z: number;
  yawDeg: number;
  alignDeg: number;
}

// Курс камеры на плоскости пола из forward-вектора AR (восток=+x, север=-z):
// 0..360, по часовой от севера — как warehouse headingDeg и магнитометр.
export function groundHeadingDeg(fx: number, fz: number): number {
  const deg = (Math.atan2(fx, -fz) * 180) / Math.PI;
  return normalizeDeg(deg);
}

// Поворот вектора (восток, север) по часовой на deg «в смысле курса»:
// вектор курса 0 (0,1) после поворота на a даёт (sin a, cos a) = курс a.
function rotateCw(
  east: number,
  north: number,
  deg: number,
): { east: number; north: number } {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { east: east * c + north * s, north: -east * s + north * c };
}

// Зафиксировать AR-референс по позе якоря (склад) и первому AR-замеру.
export function makeArReference(anchor: NavAnchor, s: ArSample): ArReference {
  const yawDeg = groundHeadingDeg(s.fx, s.fz);
  return { x: s.x, z: s.z, yawDeg, alignDeg: normalizeDeg(anchor.headingDeg - yawDeg) };
}

// Текущая поза «вы здесь» в координатах склада по AR-замеру и референсу.
export function arPose(anchor: NavAnchor, ref: ArReference, s: ArSample): NavAnchor {
  const eastA = s.x - ref.x;
  const northA = -(s.z - ref.z);
  const { east, north } = rotateCw(eastA, northA, ref.alignDeg);
  const headingDeg = normalizeDeg(groundHeadingDeg(s.fx, s.fz) + ref.alignDeg);
  return {
    warehouseId: anchor.warehouseId,
    xM: anchor.xM + east,
    yM: anchor.yM + north,
    headingDeg,
  };
}

// Обратное преобразование: точка склада (xM,yM) → координаты пола AR-мира {x,z}.
// Нужно, чтобы поставить 3D-маяк над целевой ячейкой в AR-сцене.
export function warehouseToArGround(
  anchor: NavAnchor,
  ref: ArReference,
  point: { xM: number; yM: number },
): { x: number; z: number } {
  const east = point.xM - anchor.xM;
  const north = point.yM - anchor.yM;
  // Обратный поворот на align (по часовой на -align) → компоненты AR-мира.
  const { east: eastA, north: northA } = rotateCw(east, north, -ref.alignDeg);
  return { x: ref.x + eastA, z: ref.z - northA };
}

// Пройденная по полу дистанция от референса (для индикатора/подсказки о дрейфе).
export function arTravelM(ref: ArReference, s: ArSample): number {
  const dx = s.x - ref.x;
  const dz = s.z - ref.z;
  return Math.sqrt(dx * dx + dz * dz);
}
