# @smartstack/installer-glue

Склейка персональных установщиков **без перекомпиляции** (executable gluing).
Personalize a prebuilt executable in milliseconds by appending a config tail — no recompile.

> ⚠️ **Этот приём убран из основного продукта SmartStock** (антивирусы метят
> overlay как дроппер). Продукт перешёл на sidecar (exe + manifest.json рядом).
> Почему и на что заменили — **[WHY_REMOVED_FROM_PRODUCT.md](./WHY_REMOVED_FROM_PRODUCT.md)**.
> Здесь способ сохранён как референс для сценариев без требований к AV-репутации.

---

## Зачем это нужно (RU)

Базовый `SmartStock-base.exe` собирается **один раз** и содержит **все модули**.
При создании учётной записи сервер не пересобирает приложение (не нужны Qt/MSVC,
не нужна тяжёлая CI-сборка) — он просто **дописывает в конец бинаря хвост**:
персональный `manifest.json` (адрес сервера, токен привязки, логин, роль, список
складов, флаги включённых вкладок) и набор файлов (логотип, шаблоны печати, лицензия).

При первом запуске приложение **читает свой собственный хвост** и настраивается под
конкретного пользователя. Результат: персональный установщик за миллисекунды, на любой
ОС, без тулчейна. Тот же приём работает и для **APK** (Android), потому что лишние байты
после полезной нагрузки игнорируются загрузчиком.

> Один бинарник для всех ролей — отличается только вшитый хвост.

## What it is (EN)

A tiny, dependency-free Node.js library + CLI that appends a manifest/config tail to a
prebuilt base executable so it can be personalized **without recompiling**. The server
glues a per-user tail (manifest JSON + extra files) onto one base `.exe`/`.apk`; the
client reads **its own tail** at startup and configures itself. CRC32 is **zlib-compatible**,
so a native (C++ `zlib::crc32`) reader validates the same bytes.

---

## Формат хвоста / Byte layout

```
[оригинальный exe]
[MAGIC               : 8 байт  = "SMSTOCK1"]
[manifest length     : uint32 LE]
[manifest.json       : UTF-8]
[файлы, fileCount раз]:
    [name length     : uint32 LE][name UTF-8]
    [data length     : uint32 LE][data]
[FOOTER              : 24 байта]:
    [magic offset    : uint64 LE — смещение MAGIC = размер базового exe]
    [CRC32           : uint32 LE — CRC32 payload (от MAGIC до начала FOOTER)]
    [file count      : uint32 LE]
    [MAGIC           : 8 байт  — повтор "SMSTOCK1"]
```

Чтение идёт **с конца**: последние 24 байта — FOOTER, по `magic offset` находим начало
payload, проверяем ведущий MAGIC и CRC32, затем разбираем manifest и файлы.
CRC32 — zlib-совместимый (`zlib.crc32`, доступен с Node 20.15+).

---

## CLI

```bash
# Склеить: дописать manifest + файлы к base.exe
installer-glue append \
  --base SmartStock-base.exe \
  --manifest manifest.json \
  --file logo.png=./assets/logo.png \
  --file license.lic=./out/user-42.lic \
  --out SmartStock-user42.exe

# Прочитать вшитый хвост, вывести manifest и проверить CRC32
installer-glue read SmartStock-user42.exe
```

`--file name=path` можно повторять; `name` — имя, под которым файл будет лежать в хвосте.

## Программный API / Library API

```ts
import { appendPayload, extractPayload, crc32 } from '@smartstack/installer-glue';

const out = appendPayload(baseBuffer, manifest, [{ name: 'logo.png', data: logoBuf }]);
// ...записать out, отдать пользователю...

const parsed = extractPayload(out); // null если хвоста нет или CRC битый
// parsed.manifest, parsed.files
```

Экспортируется также `MAGIC`, `MAGIC_LEN`, `FOOTER_LEN` и типы `EmbeddedFile`,
`ExtractedPayload`.

---

## Клиентский ридер / Matching reader

На стороне клиента приложение читает **свой собственный** бинарь (свой `argv[0]` /
путь к exe), берёт последние 24 байта как FOOTER, по `magic offset` находит payload и
проверяет CRC32. Поскольку CRC32 здесь **zlib-совместимый**, нативный ридер на C++
(`zlib::crc32`) валидирует ровно те же байты, что и эта библиотека.

## Установка и сборка

```bash
npm install
npm run build   # tsc → dist/
npm test        # vitest
```

Без runtime-зависимостей (только встроенный `node:zlib`). Требуется Node >= 20.15.

## Лицензия

MIT.
