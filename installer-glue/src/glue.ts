// Склейка персонального установщика (executable gluing).
//
// Базовый base.exe (или .apk) собирается один раз и содержит все модули.
// При создании учётки сервер дописывает в КОНЕЦ бинаря хвост с manifest.json
// и набором файлов. Десктопный ConfigReader (C++/Qt) читает этот хвост при
// первом запуске. ФОРМАТ ХВОСТА ЗАФИКСИРОВАН ConfigReader — повторяем байт-в-байт:
//
//   [оригинальный exe]
//   [MAGIC               : 8 байт  = "SMSTOCK1"]
//   [manifest length     : uint32 LE]
//   [manifest.json       : UTF-8]
//   [файлы, fileCount раз]:
//       [name length     : uint32 LE][name UTF-8]
//       [data length     : uint32 LE][data]
//   [FOOTER              : 24 байта]:
//       [magic offset    : uint64 LE — смещение MAGIC = размер базового exe]
//       [CRC32           : uint32 LE — CRC32 payload (от MAGIC до начала FOOTER)]
//       [file count      : uint32 LE]
//       [MAGIC           : 8 байт  — повтор "SMSTOCK1"]
//
// CRC32 — zlib-совместимый (тот же алгоритм, что zlib::crc32 в десктопе).
// Node 20.15+/24 предоставляет zlib.crc32; типы @types/node могут его не знать —
// приводим через (zlib as any).crc32.

import zlib from 'node:zlib';

export const MAGIC = Buffer.from('SMSTOCK1', 'latin1'); // 8 байт
export const MAGIC_LEN = 8;
export const FOOTER_LEN = 24; // uint64 + uint32 + uint32 + 8 байт MAGIC

export interface EmbeddedFile {
  name: string;
  data: Buffer;
}

export interface ExtractedPayload {
  manifest: unknown;
  files: EmbeddedFile[];
}

// CRC32 (zlib-совместимый) по буферу. zlib.crc32 доступен с Node 20.15+ (в проекте Node 24).
// @types/node может не знать про crc32 — приводим тип явно.
export function crc32(data: Buffer): number {
  const fn = (zlib as unknown as { crc32?: (buf: Buffer, value?: number) => number }).crc32;
  if (typeof fn !== 'function') {
    throw new Error('zlib.crc32 недоступен — нужен Node 20.15+');
  }
  // >>> 0 — привести к беззнаковому 32-битному (CRC хранится как uint32 LE).
  return fn(data) >>> 0;
}

// Собрать payload (без FOOTER): MAGIC + len(manifest) + manifest + N×(len+name+len+data).
function buildPayload(manifest: unknown, files: EmbeddedFile[]): Buffer {
  const parts: Buffer[] = [MAGIC];

  const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8');
  const manLen = Buffer.allocUnsafe(4);
  manLen.writeUInt32LE(manifestJson.length, 0);
  parts.push(manLen, manifestJson);

  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const nameLen = Buffer.allocUnsafe(4);
    nameLen.writeUInt32LE(name.length, 0);
    const dataLen = Buffer.allocUnsafe(4);
    dataLen.writeUInt32LE(f.data.length, 0);
    parts.push(nameLen, name, dataLen, f.data);
  }

  return Buffer.concat(parts);
}

// Дописать хвост к базовому бинарю и вернуть готовый «exe со вшитой конфигурацией».
// baseBuffer не модифицируется (Buffer.concat создаёт новый буфер).
export function appendPayload(
  baseBuffer: Buffer,
  manifest: unknown,
  files: EmbeddedFile[],
): Buffer {
  const payload = buildPayload(manifest, files);

  // FOOTER: [u64 magicOffset][u32 crc][u32 fileCount][8 MAGIC].
  const footer = Buffer.allocUnsafe(FOOTER_LEN);
  footer.writeBigUInt64LE(BigInt(baseBuffer.length), 0); // смещение MAGIC = размер базы
  footer.writeUInt32LE(crc32(payload), 8); // CRC32 payload
  footer.writeUInt32LE(files.length, 12); // число файлов
  MAGIC.copy(footer, 16); // повтор MAGIC

  return Buffer.concat([baseBuffer, payload, footer]);
}

// Обратное чтение хвоста (для round-trip-тестов и валидации). Любая ошибка
// (нет хвоста, неверный MAGIC, битый CRC, обрезанные данные) → null (без исключений).
export function extractPayload(buffer: Buffer): ExtractedPayload | null {
  if (buffer.length < FOOTER_LEN + MAGIC_LEN + 4) return null;

  // 1. Последние 24 байта — FOOTER.
  const footerStart = buffer.length - FOOTER_LEN;
  const footer = buffer.subarray(footerStart);

  // Завершающий MAGIC.
  if (!footer.subarray(FOOTER_LEN - MAGIC_LEN).equals(MAGIC)) return null;

  const magicOffset = Number(footer.readBigUInt64LE(0));
  const storedCrc = footer.readUInt32LE(8);
  const fileCount = footer.readUInt32LE(12);

  if (magicOffset < 0 || magicOffset >= footerStart) return null;

  const payloadLen = footerStart - magicOffset;
  if (payloadLen < MAGIC_LEN + 4) return null;

  // 2. payload и ведущий MAGIC.
  const payload = buffer.subarray(magicOffset, footerStart);
  if (!payload.subarray(0, MAGIC_LEN).equals(MAGIC)) return null;

  // 3. CRC32 payload.
  if (crc32(payload) !== storedCrc) return null;

  // 4. После MAGIC — длина manifest и сам manifest.
  let off = MAGIC_LEN;
  if (off + 4 > payload.length) return null;
  const manLen = payload.readUInt32LE(off);
  off += 4;
  if (off + manLen > payload.length) return null;
  const manBytes = payload.subarray(off, off + manLen);
  off += manLen;

  let manifest: unknown;
  try {
    manifest = JSON.parse(manBytes.toString('utf8'));
  } catch {
    return null;
  }

  // 5. Файлы: fileCount записей [u32 nameLen][name][u32 dataLen][data].
  const files: EmbeddedFile[] = [];
  for (let i = 0; i < fileCount; i++) {
    if (off + 4 > payload.length) return null;
    const nameLen = payload.readUInt32LE(off);
    off += 4;
    if (off + nameLen > payload.length) return null;
    const name = payload.subarray(off, off + nameLen).toString('utf8');
    off += nameLen;

    if (off + 4 > payload.length) return null;
    const dataLen = payload.readUInt32LE(off);
    off += 4;
    if (off + dataLen > payload.length) return null;
    const data = Buffer.from(payload.subarray(off, off + dataLen));
    off += dataLen;

    files.push({ name, data });
  }

  return { manifest, files };
}
