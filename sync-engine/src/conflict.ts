// Классификация конфликтов синхронизации — ДВА типа, разное разрешение.
//
// Извлечено из SmartStock (packages/api/src/modules/sync: merge.service.ts +
// conflict.service.ts + service.ts). В боевом коде эта логика размазана по
// слоям с Prisma/Fastify; здесь — чистые функции над простыми входами.
//
//  - ФИЗИЧЕСКИЙ конфликт (остаток в минус): два ПК офлайн списали 30+30, было 50.
//    Оба списания ВАЛИДНЫ — факт есть факт. Списываем сколько было, разницу
//    фиксируем как недостачу (shortage) и просим инвентаризацию. Голосование
//    НЕ нужно: никто не «прав» или «неправ», это расхождение учёта с реальностью.
//
//  - СМЫСЛОВОЙ конфликт (конкуррентные правки одного поля): цена 80₽ на ПК-A и
//    85₽ на ПК-B, оба офлайн. Детектируется через vector clocks (isConcurrent).
//    Поле ЗАМОРАЖИВАЕТСЯ, открывается ГОЛОСОВАНИЕ; пользователи с правом на
//    сущность выбирают вариант, большинство → в БД. Равенство/дедлайн → админ,
//    админ может закрыть досрочно (вето).

import { dominates, isConcurrent, type VectorClock } from './vector-clock';

// ─────────────────────────────────────────────────────────────────────────────
// Физический конфликт: списание против доступного остатка
// ─────────────────────────────────────────────────────────────────────────────

export interface PhysicalInput {
  // Сколько просят списать.
  requested: number;
  // Сколько реально доступно (quantity - reserved). Может быть 0 (партии нет).
  available: number;
}

export type PhysicalOutcome =
  // Хватило: списываем всё запрошенное.
  | { kind: 'applied'; writeoff: number }
  // Не хватило: списываем сколько есть, остаток — недостача (нужна инвентаризация).
  | { kind: 'physical_conflict'; writeoff: number; shortage: number; available: number };

// Допуск на погрешность float (как EPS в боевом батч-учёте).
export const EPS = 1e-9;

// Классификация физического исхода списания. Частичное списание ДОПУСТИМО:
// списываем min(requested, available), разницу возвращаем как shortage.
export function classifyPhysical(input: PhysicalInput): PhysicalOutcome {
  const available = Math.max(0, input.available);
  const writeoff = Math.min(input.requested, available);
  const shortage = input.requested - writeoff;
  if (shortage > EPS) {
    return { kind: 'physical_conflict', writeoff, shortage, available };
  }
  return { kind: 'applied', writeoff };
}

// ─────────────────────────────────────────────────────────────────────────────
// Смысловой конфликт: конкуррентная правка одного поля
// ─────────────────────────────────────────────────────────────────────────────

// Вердикт для входящей правки поля относительно последней принятой правки ТОГО ЖЕ
// поля (если она есть).
export enum FieldVerdict {
  // Первая правка поля или входящая — потомок последней: применяем.
  Apply = 'apply',
  // Последняя доминирует над входящей: правка устарела, тихо игнорируем
  // (десктоп получит актуальное значение по pull).
  Stale = 'stale',
  // Ни одна не доминирует (isConcurrent): СМЫСЛОВОЙ конфликт → голосование.
  Concurrent = 'concurrent',
}

export interface SemanticInput {
  // Вектор часов входящей правки.
  incoming: VectorClock;
  // Вектор часов последней ПРИНЯТОЙ правки этого же поля; null — правок не было.
  last: VectorClock | null;
}

// Классификация смысловой правки по vector clocks. Воспроизводит логику
// SyncService.classifyProductUpdate (service.ts) в чистом виде.
export function classifySemantic(input: SemanticInput): FieldVerdict {
  // Первая правка поля — применяем без вопросов.
  if (input.last === null) return FieldVerdict.Apply;

  const { incoming, last } = input;

  // Входящая — потомок последней (видела её) → новее, применяем.
  if (dominates(incoming, last)) return FieldVerdict.Apply;

  // Хранимая доминирует и они НЕ конкуррентны → входящая устарела.
  if (dominates(last, incoming) && !isConcurrent(incoming, last)) {
    return FieldVerdict.Stale;
  }

  // Иначе — конкуррентны: открываем голосование.
  return FieldVerdict.Concurrent;
}

// ─────────────────────────────────────────────────────────────────────────────
// Голосование (смысловой конфликт): чистый подсчёт исхода
// ─────────────────────────────────────────────────────────────────────────────

export type Choice = 'a' | 'b';
export type ResolutionMode = 'majority' | 'veto' | 'admin';

export interface VoteTally {
  a: number;
  b: number;
  // Сколько пользователей ИМЕЮТ право голоса (для авторазрешения).
  eligible: number;
  // Сколько уже проголосовало.
  cast: number;
}

export type VoteResolution =
  // Решение принято автоматически (большинство при полном кворуме / явном перевесе).
  | { resolved: true; winner: Choice; mode: 'majority' }
  // Голосование продолжается.
  | { resolved: false };

// Авторазрешение по большинству: все правомочные проголосовали и есть перевес.
// Воспроизводит ветку из ConflictService.vote: choices.length >= eligible && a!=b.
export function tallyVote(t: VoteTally): VoteResolution {
  if (t.cast >= t.eligible && t.a !== t.b) {
    return { resolved: true, winner: t.a > t.b ? 'a' : 'b', mode: 'majority' };
  }
  return { resolved: false };
}

// Разрешение админом: majority — по текущему перевесу (равенство → бросок),
// veto — выбор админа напрямую (choice обязателен).
// Воспроизводит ConflictService.resolve.
export function resolveByAdmin(
  t: Pick<VoteTally, 'a' | 'b'>,
  mode: 'majority' | 'veto',
  choice?: Choice,
): { winner: Choice; mode: ResolutionMode } {
  if (mode === 'veto') {
    if (!choice) throw new Error('Для вето укажите вариант (a|b)');
    return { winner: choice, mode: 'veto' };
  }
  if (t.a === t.b) throw new Error('Равенство голосов — требуется вето админа');
  return { winner: t.a > t.b ? 'a' : 'b', mode: 'majority' };
}
