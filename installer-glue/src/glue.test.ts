// Тесты склейки (round-trip / CRC / FOOTER) — чистая логика, без HTTP.
//
// Покрытие:
//   - appendPayload→extractPayload round-trip (manifest и files совпадают);
//   - CRC: порча байта payload → extract возвращает null;
//   - FOOTER: magicOffset == размер базового бинаря;
//   - нет хвоста (обычный exe) → null;
//   - crc32 совпадает с zlib для известного значения.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendPayload,
  extractPayload,
  extractTo,
  readSidecar,
  readManifest,
  crc32,
  MAGIC,
  FOOTER_LEN,
  SIDECAR_NAME,
  type ExtractedPayload,
} from './glue';

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

describe('glue extractTo', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'glue-extract-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trip: файлы пишутся на диск с исходным содержимым', () => {
    const payload: ExtractedPayload = {
      manifest: { ok: true },
      files: [
        { name: 'logo.png', data: Buffer.from([1, 2, 3, 4, 5]) },
        { name: 'кириллица.txt', data: Buffer.from('содержимое', 'utf8') },
        { name: 'nested/sub/config.ini', data: Buffer.from('a=1', 'utf8') },
      ],
    };
    const written = extractTo(payload, dir);
    expect(written).toHaveLength(3);
    expect(readFileSync(join(dir, 'logo.png'))).toEqual(payload.files[0].data);
    expect(readFileSync(join(dir, 'кириллица.txt'))).toEqual(payload.files[1].data);
    expect(readFileSync(join(dir, 'nested', 'sub', 'config.ini'))).toEqual(payload.files[2].data);
  });

  it('создаёт каталог назначения, если его нет', () => {
    const sub = join(dir, 'does', 'not', 'exist');
    extractTo({ manifest: {}, files: [{ name: 'a.txt', data: Buffer.from('x') }] }, sub);
    expect(readFileSync(join(sub, 'a.txt')).toString()).toBe('x');
  });

  it('end-to-end через appendPayload→extractPayload→extractTo', () => {
    const base = Buffer.from('FAKE_BASE_EXE');
    const files = [{ name: 'data.bin', data: Buffer.from([9, 8, 7]) }];
    const merged = appendPayload(base, { m: 1 }, files);
    const extracted = extractPayload(merged);
    expect(extracted).not.toBeNull();
    const written = extractTo(extracted!, dir);
    expect(written).toHaveLength(1);
    expect(readFileSync(join(dir, 'data.bin'))).toEqual(files[0].data);
  });

  // Path-traversal: каждое опасное имя должно бросать исключение и НЕ создавать
  // файл за пределами каталога назначения.
  const traversalNames = [
    '../escape.txt',
    '..\\escape.txt',
    'a/../../escape.txt',
    'sub/../../escape.txt',
    '/etc/passwd',
    '\\\\server\\share\\x',
    'C:\\Windows\\x.txt',
    'D:/data/x.txt',
    'nested/../../out.txt',
  ];
  for (const name of traversalNames) {
    it(`отклоняет path-traversal: ${JSON.stringify(name)}`, () => {
      const payload: ExtractedPayload = {
        manifest: {},
        files: [{ name, data: Buffer.from('pwned') }],
      };
      expect(() => extractTo(payload, dir)).toThrow();
      // Ничего не утекло на уровень выше каталога назначения.
      expect(existsSync(join(dir, '..', 'escape.txt'))).toBe(false);
      expect(existsSync(join(dir, '..', 'out.txt'))).toBe(false);
    });
  }
});

describe('glue readSidecar/readManifest', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'glue-sidecar-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('readSidecar: round-trip JSON-объекта', () => {
    const manifest = { config: { serverUrl: 'http://x' }, modules: { dashboard: true } };
    writeFileSync(join(dir, SIDECAR_NAME), JSON.stringify(manifest), 'utf8');
    const res = readSidecar(dir);
    expect(res).not.toBeNull();
    expect(res!.manifest).toEqual(manifest);
    expect(res!.files).toHaveLength(0);
  });

  it('readSidecar: нет файла → null', () => {
    expect(readSidecar(dir)).toBeNull();
  });

  it('readSidecar: битый JSON → null', () => {
    writeFileSync(join(dir, SIDECAR_NAME), '{ не json', 'utf8');
    expect(readSidecar(dir)).toBeNull();
  });

  it('readSidecar: не-объект (массив/скаляр) → null', () => {
    writeFileSync(join(dir, SIDECAR_NAME), '[1,2,3]', 'utf8');
    expect(readSidecar(dir)).toBeNull();
    writeFileSync(join(dir, SIDECAR_NAME), '42', 'utf8');
    expect(readSidecar(dir)).toBeNull();
  });

  it('readManifest: предпочитает sidecar рядом с exe', () => {
    const manifest = { source: 'sidecar' };
    const exePath = join(dir, 'app.exe');
    // exe с ДРУГИМ вшитым хвостом — sidecar должен победить.
    writeFileSync(exePath, appendPayload(Buffer.from('BASE'), { source: 'tail' }, []));
    writeFileSync(join(dir, SIDECAR_NAME), JSON.stringify(manifest), 'utf8');
    const res = readManifest(exePath);
    expect(res!.manifest).toEqual(manifest);
  });

  it('readManifest: без sidecar откатывается к хвосту exe', () => {
    const manifest = { source: 'tail' };
    const exePath = join(dir, 'app.exe');
    writeFileSync(exePath, appendPayload(Buffer.from('BASE'), manifest, []));
    const res = readManifest(exePath);
    expect(res!.manifest).toEqual(manifest);
  });

  it('readManifest: ни sidecar, ни хвоста → null', () => {
    const exePath = join(dir, 'plain.exe');
    writeFileSync(exePath, Buffer.from('JUST_A_PLAIN_EXE_NO_TAIL'));
    expect(readManifest(exePath)).toBeNull();
  });
});
