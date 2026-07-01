// E2E-кодек «кадра журнала» реле — ТЕКУЩИЙ стек оригинала SmartStock.
//
// Портирован по семантике (не по байтам) из десктопа:
//   include/core/sync/SyncCodec.hpp + src/core/sync/SyncCodec.cpp.
//
// Назначение: ЕДИНЫЙ wire-формат кадра для транспорта-реле (и P2P). Пакет
// операций (JSON) → zlib-сжатие (только если реально уменьшает) → AES-256-GCM
// (E2E, шифрование ВСЕГДА включено). Реле видит лишь шифротекст + случайный IV;
// без ключа содержимое не прочитать. На мобильном клиенте тот же формат — на
// WebCrypto(AES-GCM)+pako(zlib); здесь — node:crypto + node:zlib.
//
// Формат кадра (байты):
//   magic(4)="SSJ1" | ver(1)=1 | flags(1) | iv(12) | ciphertext(N) | tag(16)
// Заголовок (6 байт magic+ver+flags) — это AAD GCM: подделка версии/флагов
// ломает проверку тега. flags bit0 (0x01) = payload сжат zlib.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// 256-битный симметричный ключ E2E (общий для парных устройств; рождается при
// сопряжении, передаётся QR-кодом, в реле НЕ попадает).
export type Key = Buffer; // 32 байта

// Одна операция журнала. data — произвольная полезная нагрузка (receive/
// writeoff/inventory_count/price_change/create_product/snapshot).
export interface SyncOp {
  opId: string; // UUID операции — КЛЮЧ ИДЕМПОТЕНТНОСТИ (op_id)
  type: string; // тип операции
  device: string; // id устройства-источника
  ts: number; // время, epoch-МИЛЛИСЕКУНДЫ (курсор реле тоже в мс)
  data: unknown; // полезная нагрузка операции
}

// ── Константы формата (зеркало SyncCodec.cpp) ────────────────────────────────
const MAGIC = Buffer.from('SSJ1', 'ascii'); // 4 байта
const VERSION = 1;
const FLAG_COMPRESSED = 0x01;
const HEADER_LEN = 6; // magic(4)+ver(1)+flags(1)
const IV_LEN = 12;
const TAG_LEN = 16;

// Случайный ключ через CSPRNG (32 байта).
export function generateKey(): Key {
  return randomBytes(32);
}

// Ключ ↔ строка (base64url без паддинга) — для QR/хранения.
export function keyToString(key: Key): string {
  return key.toString('base64url');
}

export function keyFromString(s: string): Key {
  const raw = Buffer.from(s, 'base64url');
  if (raw.length !== 32) {
    throw new Error('ключ: неверная длина (ожидается 32 байта)');
  }
  return raw;
}

// Идемпотентный идентификатор операции ("op_" + 128 случайных бит в hex).
export function newOpId(): string {
  return 'op_' + randomBytes(16).toString('hex');
}

// ── Пакет операций ↔ JSON (чистые построитель/парсер) ────────────────────────
export function buildBatchJson(ops: SyncOp[]): string {
  return JSON.stringify({
    v: 1,
    ops: ops.map((op) => ({
      op_id: op.opId,
      type: op.type,
      device: op.device,
      ts: op.ts,
      data: op.data ?? {},
    })),
  });
}

// Разбор устойчив: битый/враждебный элемент (не-объект или поле неверного типа)
// пропускается ПООДИНОЧНО, не роняя разбор всего пакета (теряя валидные ops).
export function parseBatchJson(json: string): SyncOp[] {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    throw new Error('batch: некорректный JSON');
  }
  if (typeof root !== 'object' || root === null || !Array.isArray((root as { ops?: unknown }).ops)) {
    throw new Error('batch: нет массива ops');
  }
  const out: SyncOp[] = [];
  for (const el of (root as { ops: unknown[] }).ops) {
    if (typeof el !== 'object' || el === null) continue;
    const j = el as Record<string, unknown>;
    const opId = typeof j['op_id'] === 'string' ? (j['op_id'] as string) : '';
    const type = typeof j['type'] === 'string' ? (j['type'] as string) : '';
    const device = typeof j['device'] === 'string' ? (j['device'] as string) : '';
    const ts = typeof j['ts'] === 'number' ? (j['ts'] as number) : 0;
    const data = 'data' in j ? j['data'] : {};
    out.push({ opId, type, device, ts, data });
  }
  return out;
}

// ── Кадр: произвольный текст ↔ сжатый+зашифрованный конверт ───────────────────
// encodeFrame: plaintext → [magic|ver|flags|iv|ciphertext|tag]. Сжатие только
// если реально уменьшает размер (иначе payload хранится как есть, флаг отражает).
export function encodeFrame(plaintext: string, key: Key): Buffer {
  const raw = Buffer.from(plaintext, 'utf8');

  // 1) Сжатие — только если реально уменьшает.
  let flags = 0;
  let payload = raw;
  const compressed = deflateSync(raw, { level: 9 });
  if (compressed.length < raw.length) {
    flags |= FLAG_COMPRESSED;
    payload = compressed;
  }

  // 2) Заголовок (он же AAD — аутентифицируется тегом).
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION, flags])]); // 6 байт

  // 3) Случайный IV.
  const iv = randomBytes(IV_LEN);

  // 4) Шифрование payload, AAD = заголовок.
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 байт

  return Buffer.concat([header, iv, ciphertext, tag]);
}

// decodeFrame: проверяет magic/версию и тег GCM (целостность+подлинность),
// расшифровывает и при необходимости распаковывает. Неверный ключ/повреждение →
// исключение (а не мусор).
export function decodeFrame(frame: Buffer, key: Key): string {
  if (frame.length < HEADER_LEN + IV_LEN + TAG_LEN) {
    throw new Error('кадр: слишком короткий');
  }
  if (!frame.subarray(0, 4).equals(MAGIC)) {
    throw new Error('кадр: неверная сигнатура');
  }
  if (frame[4] !== VERSION) {
    throw new Error('кадр: неподдерживаемая версия');
  }
  const flags = frame[5]!;

  const header = frame.subarray(0, HEADER_LEN);
  const iv = frame.subarray(HEADER_LEN, HEADER_LEN + IV_LEN);
  const tag = frame.subarray(frame.length - TAG_LEN);
  const ciphertext = frame.subarray(HEADER_LEN + IV_LEN, frame.length - TAG_LEN);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  let payload: Buffer;
  try {
    payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Тег не сошёлся: неверный ключ или повреждение.
    throw new Error('gcm: проверка подлинности не пройдена (неверный ключ или повреждение)');
  }

  if (flags & FLAG_COMPRESSED) {
    try {
      payload = inflateSync(payload);
    } catch {
      throw new Error('zlib: повреждённый или усечённый поток');
    }
  }
  return payload.toString('utf8');
}

// ── Те же кадры в base64 — для передачи в JSON реле / по тексту ───────────────
export function encodeFrameBase64(plaintext: string, key: Key): string {
  return encodeFrame(plaintext, key).toString('base64');
}

export function decodeFrameBase64(frameB64: string, key: Key): string {
  return decodeFrame(Buffer.from(frameB64, 'base64'), key);
}

// ── Высокий уровень: пакет операций → кадр base64 и обратно ───────────────────
export function encodeBatchBase64(ops: SyncOp[], key: Key): string {
  return encodeFrameBase64(buildBatchJson(ops), key);
}

export function decodeBatchBase64(frameB64: string, key: Key): SyncOp[] {
  return parseBatchJson(decodeFrameBase64(frameB64, key));
}
