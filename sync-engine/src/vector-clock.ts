// Vector clocks — обнаружение конкуррентности правок без доверия часам ПК.
//
// Вектор часов: deviceId → монотонный счётчик. Каждое устройство инкрементирует
// СВОЙ компонент при локальной записи. Сравнивая два вектора, мы понимаем
// причинно-следственную связь между операциями: одна «знала» о другой (потомок),
// или они сделаны параллельно (оба были офлайн → конкуррентны).
//
// dominates/isConcurrent скопированы ВЕРБАТИМ из боевого SmartStock
// (packages/api/src/modules/sync/conflict.service.ts) — это ядро детекции
// смысловых конфликтов. increment/merge — стандартные хелперы (в боевом коде
// инкремент вектора делает десктоп, здесь даём чистую общую реализацию).

// Вектор часов: deviceId → счётчик.
export type VectorClock = Record<string, number>;

// a доминирует над b (a — потомок b): для всех компонент a[k] >= b[k].
// Иначе говоря, a «видел» всё, что видел b (и, возможно, больше). Если a
// доминирует над b, то a причинно следует за b — конфликта нет, a новее.
export function dominates(a: VectorClock, b: VectorClock): boolean {
  for (const k of Object.keys(b)) {
    if ((a[k] ?? 0) < (b[k] ?? 0)) return false;
  }
  return true;
}

// Конкуррентны: никто не доминирует (правки «параллельны» — был офлайн).
// Это ключевой предикат смыслового конфликта: две правки, ни одна из которых
// не знала о другой, нельзя упорядочить причинно → нужно разрешение (голосование).
export function isConcurrent(a: VectorClock, b: VectorClock): boolean {
  return !dominates(a, b) && !dominates(b, a);
}

// Инкремент собственного компонента устройства перед локальной записью.
// Не мутирует вход — возвращает новый вектор (удобно для функционального стиля).
// Пример: устройство D, сделав операцию, зовёт increment(vc, 'D') → vc.D += 1.
export function increment(vc: VectorClock, deviceId: string): VectorClock {
  return { ...vc, [deviceId]: (vc[deviceId] ?? 0) + 1 };
}

// Слияние двух векторов: покомпонентный максимум. Применяется, когда устройство
// узнаёт о чужих операциях (после pull) — его знание «вбирает» чужое.
// merge(a, b) доминирует и над a, и над b.
export function merge(a: VectorClock, b: VectorClock): VectorClock {
  const out: VectorClock = { ...a };
  for (const k of Object.keys(b)) {
    out[k] = Math.max(out[k] ?? 0, b[k] ?? 0);
  }
  return out;
}
