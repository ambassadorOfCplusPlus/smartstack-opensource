// Оркестрация реле — ТЕКУЩИЙ стек оригинала SmartStock.
//
// Портирован по семантике из десктопа:
//   include/core/sync/SyncOrchestrator.hpp + src/core/sync/SyncOrchestrator.cpp.
//
// Связывает реле + кодек + движок:
//   pushBatch — операции → кадр (E2E) → relay.append.
//   pullApply — relay.poll(курсор) → расшифровка кадров → applyBatch → сдвиг курсора.
// Реле абстрактно (IRelay) → тестируется на фейке без сети. Курсор — ts (epoch-мс).

import { encodeBatchBase64, decodeBatchBase64, type Key, type SyncOp } from './codec';
import { applyBatch, type IDedupStore, type ISyncApplier } from './engine';
import type { IRelay } from './relay';

export interface PullResult {
  total: number; // кадров получено из реле
  applied: number; // операций проведено
  duplicates: number; // пропущено как уже применённые
  rejected: number; // отклонено (включая нерасшифрованные/чужие кадры)
  cursor: number; // новое значение курсора (максимальный полученный ts)
}

// Отправить пакет операций в реле одним зашифрованным кадром (ts — epoch-мс).
export async function pushBatch(
  relay: IRelay,
  key: Key,
  device: string,
  ops: SyncOp[],
  ts: number,
): Promise<void> {
  const frameB64 = encodeBatchBase64(ops, key);
  await relay.append(ts, device, frameB64);
}

// Применить ОДИН сырой зашифрованный кадр base64 (как из P2P-сокета или реле):
// расшифровка → разбор пакета → applyBatch. Общий путь для реле и P2P.
// settledOpIds (опц.) — сюда добавляются op_id «улаженных» операций
// (applied|duplicate, т.е. их можно удалять из очереди источника).
export async function applyOneFrame(
  frameB64: string,
  key: Key,
  applier: ISyncApplier,
  dedup: IDedupStore,
  settledOpIds?: string[],
): Promise<PullResult> {
  const result: PullResult = { total: 1, applied: 0, duplicates: 0, rejected: 0, cursor: 0 };
  let ops: SyncOp[];
  try {
    ops = decodeBatchBase64(frameB64, key);
  } catch {
    // Нерасшифрованный/чужой кадр — считаем отклонённым, но не роняем цикл.
    result.rejected += 1;
    return result;
  }
  const outcomes = await applyBatch(ops, applier, dedup);
  for (const r of outcomes) {
    if (r.status === 'applied') {
      result.applied += 1;
      settledOpIds?.push(r.opId);
    } else if (r.status === 'duplicate') {
      result.duplicates += 1;
      settledOpIds?.push(r.opId);
    } else {
      result.rejected += 1;
    }
  }
  return result;
}

// Забрать новые кадры (ts >= cursor), расшифровать и применить. Курсор
// сдвигается за максимальный полученный ts (даже по нерасшифрованным — чтобы не
// застревать). selfDevice (опц.) — id ЭТОГО устройства: его собственные кадры
// пропускаются (не применяем эхо своих же пушей).
//
// Возвращает PullResult с полем cursor = НОВЫЙ курсор (вызывающий сохраняет его
// и передаёт в следующий вызов).
export async function pullApply(
  relay: IRelay,
  key: Key,
  applier: ISyncApplier,
  dedup: IDedupStore,
  cursor: number,
  limit = 100,
  selfDevice = '',
): Promise<PullResult> {
  const entries = await relay.poll(cursor, limit);
  const result: PullResult = { total: 0, applied: 0, duplicates: 0, rejected: 0, cursor };
  let maxTs = cursor;

  for (const e of entries) {
    if (e.ts > maxTs) maxTs = e.ts;
    // Пропускаем собственное эхо (свой же push).
    if (selfDevice && e.device === selfDevice) continue;
    result.total += 1;
    const one = await applyOneFrame(e.frameB64, key, applier, dedup);
    result.applied += one.applied;
    result.duplicates += one.duplicates;
    result.rejected += one.rejected;
  }

  // Курсор двигаем за максимальный ts + 1 мс, чтобы не перечитывать пограничную
  // запись (poll использует since >= cursor). Если ничего не пришло — не двигаем.
  result.cursor = entries.length > 0 ? maxTs + 1 : cursor;
  return result;
}
