#!/usr/bin/env node
// CLI для склейки/чтения хвоста установщика.
//
//   installer-glue append --base <base.exe> --manifest <manifest.json> \
//                         [--file name=path ...] --out <out.exe>
//   installer-glue read <file.exe>
//
// Использует только встроенные модули Node (fs, process) + ./glue.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { appendPayload, extractPayload, type EmbeddedFile } from './glue';

// Разобрать аргументы вида --key value (флаги) и собрать --file повторно.
interface ParsedArgs {
  flags: Record<string, string>;
  files: { name: string; path: string }[];
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const files: { name: string; path: string }[] = [];
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Флаг --${key} требует значение`);
      }
      i++;
      if (key === 'file') {
        // --file name=path
        const eq = value.indexOf('=');
        if (eq < 0) {
          throw new Error(`--file ожидает формат name=path, получено: ${value}`);
        }
        files.push({ name: value.slice(0, eq), path: value.slice(eq + 1) });
      } else {
        flags[key] = value;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, files, positional };
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (!v) {
    fail(`Не указан обязательный флаг --${name}`);
  }
  return v;
}

function fail(msg: string): never {
  process.stderr.write(`Ошибка: ${msg}\n`);
  process.exit(1);
}

const USAGE = `installer-glue — склейка персонального установщика (executable gluing)

Команды:
  append --base <base.exe> --manifest <manifest.json> [--file name=path ...] --out <out.exe>
      Дописать хвост (manifest + файлы) к base.exe и записать out.exe.

  read <file.exe>
      Прочитать вшитый хвост: вывести manifest JSON, проверить CRC32, перечислить файлы.
`;

function cmdAppend(parsed: ParsedArgs): void {
  const basePath = requireFlag(parsed.flags, 'base');
  const manifestPath = requireFlag(parsed.flags, 'manifest');
  const outPath = requireFlag(parsed.flags, 'out');

  const baseBuffer = readFileSync(basePath);

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    fail(`не удалось распарсить manifest JSON (${manifestPath}): ${(e as Error).message}`);
  }

  const files: EmbeddedFile[] = parsed.files.map((f) => ({
    name: f.name,
    data: readFileSync(f.path),
  }));

  const out = appendPayload(baseBuffer, manifest, files);
  writeFileSync(outPath, out);

  process.stdout.write(
    `OK: ${outPath} (${out.length} байт; base ${baseBuffer.length} + хвост ${
      out.length - baseBuffer.length
    }, файлов: ${files.length})\n`,
  );
}

function cmdRead(parsed: ParsedArgs): void {
  const filePath = parsed.positional[0];
  if (!filePath) {
    fail('укажите путь: installer-glue read <file.exe>');
  }

  const buffer = readFileSync(filePath);
  const extracted = extractPayload(buffer);
  if (!extracted) {
    fail(`хвост не найден или повреждён (нет MAGIC / битый CRC32) в ${basename(filePath)}`);
  }

  process.stdout.write('manifest:\n');
  process.stdout.write(`${JSON.stringify(extracted.manifest, null, 2)}\n`);
  process.stdout.write(`\nфайлов: ${extracted.files.length}\n`);
  for (const f of extracted.files) {
    process.stdout.write(`  - ${f.name} (${f.data.length} байт)\n`);
  }
  process.stdout.write('\nCRC32: OK (валиден)\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    process.exit(command ? 0 : 1);
  }

  const parsed = parseArgs(argv.slice(1));

  switch (command) {
    case 'append':
      cmdAppend(parsed);
      break;
    case 'read':
      cmdRead(parsed);
      break;
    default:
      fail(`неизвестная команда "${command}". См. installer-glue --help`);
  }
}

main();
