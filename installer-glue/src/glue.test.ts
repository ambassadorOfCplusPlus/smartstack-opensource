// Тесты склейки (round-trip / CRC / FOOTER) — чистая логика, без HTTP.
//
// Покрытие:
//   - appendPayload→extractPayload round-trip (manifest и files совпадают);
//   - CRC: порча байта payload → extract возвращает null;
//   - FOOTER: magicOffset == размер базового бинаря;
//   - нет хвоста (обычный exe) → null;
//   - crc32 совпадает с zlib для известного значения.

import { describe, it, expect } from 'vitest';
import { appendPayload, extractPayload, crc32, MAGIC, FOOTER_LEN } from './glue';

describe('glue appendPayload/extractPayload', () => {
  const base = Buffer.from('FAKE_BASE_EXE_CONTENT_1234567890');
  const manifest = { config: { serverUrl: 'http://x', login: 'a@b.c' }, modules: { dashboard: true } };
  const files = [
    { name: 'logo.png', data: Buffer.from([1, 2, 3, 4, 5]) },
    { name: 'кириллица.txt', data: Buffer.from('содержимое', 'utf8') },
  ];

  it('round-trip: manifest и files совпадают', () => {
    const merged = appendPayload(base, manifest, files);
    const extracted = extractPayload(merged);
    expect(extracted).not.toBeNull();
    expect(extracted!.manifest).toEqual(manifest);
    expect(extracted!.files).toHaveLength(2);
    expect(extracted!.files[0].name).toBe('logo.png');
    expect(extracted!.files[0].data).toEqual(files[0].data);
    expect(extracted!.files[1].name).toBe('кириллица.txt');
    expect(extracted!.files[1].data).toEqual(files[1].data);
  });

  it('round-trip без файлов', () => {
    const merged = appendPayload(base, manifest, []);
    const extracted = extractPayload(merged);
    expect(extracted).not.toBeNull();
    expect(extracted!.manifest).toEqual(manifest);
    expect(extracted!.files).toHaveLength(0);
  });

  it('итоговый файл начинается с оригинального base', () => {
    const merged = appendPayload(base, manifest, files);
    expect(merged.subarray(0, base.length)).toEqual(base);
  });

  it('FOOTER: magicOffset == размер базового бинаря', () => {
    const merged = appendPayload(base, manifest, files);
    const footer = merged.subarray(merged.length - FOOTER_LEN);
    const magicOffset = Number(footer.readBigUInt64LE(0));
    expect(magicOffset).toBe(base.length);
    // На смещении magicOffset стоит ведущий MAGIC.
    expect(merged.subarray(magicOffset, magicOffset + MAGIC.length)).toEqual(MAGIC);
    // Хвост FOOTER завершается повтором MAGIC.
    expect(footer.subarray(FOOTER_LEN - MAGIC.length)).toEqual(MAGIC);
  });

  it('CRC: порча байта payload → extract = null', () => {
    const merged = appendPayload(base, manifest, files);
    // Портим байт внутри payload (после base, до FOOTER).
    const corrupt = Buffer.from(merged);
    const idx = base.length + 12; // где-то в manifest
    corrupt[idx] = corrupt[idx] ^ 0xff;
    expect(extractPayload(corrupt)).toBeNull();
  });

  it('нет хвоста (обычный exe) → extract = null', () => {
    expect(extractPayload(base)).toBeNull();
  });

  it('crc32 совпадает с zlib для известного значения', () => {
    // zlib.crc32("hello") = 907060870 (проверено).
    expect(crc32(Buffer.from('hello'))).toBe(907060870);
  });
});
