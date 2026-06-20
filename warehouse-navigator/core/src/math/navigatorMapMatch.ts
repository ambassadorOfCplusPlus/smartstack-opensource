// Map-matching по плану склада: человек не может находиться ВНУТРИ стеллажа/стены,
// поэтому корректируем dead-reckoned позу, выталкивая её из препятствий. Это убирает
// «невозможные» смещения PDR (ушёл сквозь стеллаж). Чистая геометрия — без React
// Native, покрыта юнит-тестами (navigatorMapMatch.test.ts).
//
// Препятствия — элементы плана v24 типов rack/wall. zone/passage/door — проходимы.

export interface MapRect {
  xM: number; // центр
  yM: number;
  lengthM: number; // вдоль локальной X
  widthM: number; // вдоль локальной Y
  rotationDeg?: number;
  kind?: string;
}

const OBSTACLE_KINDS = new Set(['rack', 'wall']);

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// ТОЧНАЯ осевая ограничивающая коробка повёрнутого прямоугольника: половинные
// размеры проецируются на оси через |cos|/|sin| угла. Для 0/90/180/270 даёт ровно
// габариты (как раньше), но для косых углов — настоящую коробку, а не раздутую
// описанную окружность (иначе длинный тонкий стеллаж под малым углом «перекрывал»
// бы метры свободного прохода). Math.abs — заодно безопасность к отрицательным
// размерам/повороту.
export function rectAabb(r: MapRect): Box {
  const halfL = Math.abs(r.lengthM) / 2;
  const halfW = Math.abs(r.widthM) / 2;
  const rad = ((r.rotationDeg ?? 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const halfX = halfL * c + halfW * s;
  const halfY = halfL * s + halfW * c;
  return { minX: r.xM - halfX, maxX: r.xM + halfX, minY: r.yM - halfY, maxY: r.yM + halfY };
}

// Выталкивает точку из препятствий: если она внутри стеллажа/стены (с запасом
// marginM), сдвигает к краю. Точку в свободном пространстве не трогает. Применять к
// dead-reckoned позе PDR.
//
// `from` — предыдущая (свободная) позиция: если задана, точку выталкивают НА ТУ
// СТОРОНУ препятствия, откуда пришли. Без этого точка, за один шаг перескочившая
// середину тонкой стены, телепортировалась бы на ПРОТИВОПОЛОЖНУЮ сторону (сквозь
// стену) — ось наименьшего проникновения выбрала бы дальнюю грань. Без `from`
// поведение прежнее: ось наименьшего проникновения.
//
// Проходим по препятствиям несколько раз: вытолкнув из одного, точка может попасть
// в соседнее (стеллажи стоят вплотную). Повторяем до стабилизации с верхним пределом
// проходов (защита от зацикливания на перекрывающихся боксах).
export function snapOutOfObstacles(
  p: { xM: number; yM: number },
  rects: MapRect[],
  marginM = 0,
  from?: { xM: number; yM: number },
): { xM: number; yM: number } {
  const pt = { xM: p.xM, yM: p.yM };
  const maxPasses = Math.min(rects.length, 8) + 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (const r of rects) {
      if (!OBSTACLE_KINDS.has(r.kind ?? 'rack')) continue;
      const b = rectAabb(r);
      const minX = b.minX - marginM;
      const maxX = b.maxX + marginM;
      const minY = b.minY - marginM;
      const maxY = b.maxY + marginM;
      if (!(pt.xM > minX && pt.xM < maxX && pt.yM > minY && pt.yM < maxY)) continue;
      // Кандидаты «куда вытолкнуть» = {ось, целевая координата, глубина проникновения}.
      const cands: Array<{ axis: 'x' | 'y'; val: number; pen: number }> = [];
      if (from) {
        // Сторона, откуда пришли: грань, по которой `from` снаружи бокса.
        if (from.xM <= minX) cands.push({ axis: 'x', val: minX, pen: pt.xM - minX });
        else if (from.xM >= maxX) cands.push({ axis: 'x', val: maxX, pen: maxX - pt.xM });
        if (from.yM <= minY) cands.push({ axis: 'y', val: minY, pen: pt.yM - minY });
        else if (from.yM >= maxY) cands.push({ axis: 'y', val: maxY, pen: maxY - pt.yM });
      }
      if (cands.length === 0) {
        // Нет подсказки направления (или `from` тоже внутри) — все 4 грани.
        cands.push(
          { axis: 'x', val: minX, pen: pt.xM - minX },
          { axis: 'x', val: maxX, pen: maxX - pt.xM },
          { axis: 'y', val: minY, pen: pt.yM - minY },
          { axis: 'y', val: maxY, pen: maxY - pt.yM },
        );
      }
      let best: { axis: 'x' | 'y'; val: number; pen: number } | undefined;
      for (const cnd of cands) if (!best || cnd.pen < best.pen) best = cnd;
      if (!best) continue; // cands не пуст по построению — на всякий случай
      if (best.axis === 'x') pt.xM = best.val;
      else pt.yM = best.val;
      moved = true;
    }
    if (!moved) break;
  }
  return pt;
}
