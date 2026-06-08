// Журнал операций синхронизации: идемпотентность по UUID + монотонный serverSeq.
//
// Извлечено из SmartStock (SyncService.push в service.ts). Здесь — крошечная
// storage-agnostic версия БЕЗ Prisma/Postgres: интерфейс хранилища + in-memory
// реализация, демонстрирующая ДВА инварианта:
//
//  1. ИДЕМПОТЕНТНОСТЬ ПО UUID. id операции генерирует ДЕСКТОП. Повторная отправка
//     той же операции (потеря ответа, ретрай) НЕ применяет её снова и возвращает
//     ТОТ ЖЕ serverSeq/статус, что и в первый раз. В боевом коде это findUnique
//     по id + (под гонкой) перехват P2002 на уникальном PK.
//
//  2. МОНОТОННЫЙ serverSeq. Сервер присваивает каждой НОВОЙ операции возрастающий
//     порядковый номер (в боевом коде — Postgres autoincrement BIGINT). Десктопы
//     тянут чужие операции курсором `serverSeq > since` и применяют в этом порядке.
//
// Важная тонкость боевого pull (gap-free через xmin-горизонт) описана в
// docs/DESIGN.md — она про ВИДИМОСТЬ строк под конкуренцией транзакций и здесь,
// в синхронном in-memory сторадже, не воспроизводима (нет параллельных коммитов).

import type { VectorClock } from './vector-clock';

// Статус записи в журнале (как в боевом sync_operations.status).
export type OperationStatus = 'accepted' | 'conflict' | 'rejected';

// Операция, как её присылает устройство.
export interface SyncOperation {
  id: string; // UUID, генерирует устройство — ключ идемпотентности
  deviceId: string; // устройство-источник
  entityType: string;
  entityId: string;
  operation: string;
  payload: unknown;
  vectorClock: VectorClock;
  createdAt: string; // ISO, время на устройстве
}

// Запись журнала = операция + серверные поля.
export interface JournalEntry extends SyncOperation {
  serverSeq: bigint; // монотонный, присвоен сервером
  status: OperationStatus;
}

// Результат записи операции в журнал.
export interface AppendResult {
  entry: JournalEntry;
  // true — операция уже была (идемпотентный повтор, ничего не применилось заново).
  duplicate: boolean;
}

// Storage-agnostic контракт журнала. Боевая реализация бьётся в Postgres;
// здесь — in-memory.
export interface OperationJournal {
  // Записать операцию с заданным статусом. Идемпотентно по op.id: повтор
  // возвращает существующую запись (duplicate=true) и НЕ присваивает новый seq.
  append(op: SyncOperation, status: OperationStatus): AppendResult;
  // Найти запись по id (null — не было).
  get(id: string): JournalEntry | null;
  // Чужие операции с serverSeq > since, НЕ от deviceId, только accepted,
  // по возрастанию serverSeq. Курсор pull.
  pull(deviceId: string, since: bigint, limit: number): JournalEntry[];
  // Текущий максимальный serverSeq (0n — журнал пуст).
  maxSeq(): bigint;
}

// In-memory реализация. Не потокобезопасна (Node — однопоточен в рамках тика);
// для демонстрации инвариантов идемпотентности/монотонности достаточно.
export class InMemoryJournal implements OperationJournal {
  private readonly byId = new Map<string, JournalEntry>();
  private readonly ordered: JournalEntry[] = []; // в порядке serverSeq
  private seq = 0n;

  append(op: SyncOperation, status: OperationStatus): AppendResult {
    // 1. Идемпотентность: уже принимали эту операцию?
    const known = this.byId.get(op.id);
    if (known) {
      // Повтор — НЕ применяем снова, возвращаем прежний результат.
      return { entry: known, duplicate: true };
    }

    // 2. Новая операция — присваиваем монотонный serverSeq.
    this.seq += 1n;
    const entry: JournalEntry = { ...op, serverSeq: this.seq, status };
    this.byId.set(op.id, entry);
    this.ordered.push(entry);
    return { entry, duplicate: false };
  }

  get(id: string): JournalEntry | null {
    return this.byId.get(id) ?? null;
  }

  pull(deviceId: string, since: bigint, limit: number): JournalEntry[] {
    const out: JournalEntry[] = [];
    for (const e of this.ordered) {
      if (e.serverSeq <= since) continue;
      if (e.deviceId === deviceId) continue; // не отдаём собственные
      if (e.status !== 'accepted') continue; // conflict/rejected не реплицируем
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  maxSeq(): bigint {
    return this.seq;
  }
}
