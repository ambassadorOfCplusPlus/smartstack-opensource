# Почему «склейка хвостом» убрана из продукта (но осталась здесь)

> TL;DR: техника `installer-glue` (дозапись config-«хвоста» в конец готового
> `.exe`/`.apk`) — рабочая и элегантная, но её **побочный эффект — ложные
> срабатывания антивирусов**. В основном продукте SmartStock мы перешли на
> **sidecar**: неизменённый `.exe` + `manifest.json` РЯДОМ, упакованные в ZIP.
> Здесь, в опенсорсе, способ-«хвост» сохранён целиком — как референс и для
> сценариев, где антивирусная репутация не важна.

---

## Что делал «хвост» (recap)

Базовый `SmartStock-base.exe` собирается один раз. Чтобы персонализировать его
под пользователя без перекомпиляции, сервер **дописывал в самый конец бинаря**
блок: `[MAGIC] + manifest.json + файлы + [FOOTER: смещение + CRC32]`. Клиент при
старте читал **собственный хвост** и настраивался. См. `README.md` — формат и API.

Это «overlay» — данные после полезной нагрузки PE-файла. Загрузчик ОС их
игнорирует, поэтому exe запускается; APK (тоже ZIP) — аналогично, лишние байты
после структуры терпит большинство ридеров.

## Почему это триггерит антивирусы

1. **Overlay = типичный приём дропперов/упаковщиков.** Малварь часто прячет
   полезную нагрузку/конфиг в хвосте exe и читает себя на старте. Эвристики
   Windows Defender/SmartScreen и ряда движков (включая то, что использует
   Яндекс при проверке загрузок) реагируют именно на этот паттерн —
   «самочтение собственного файла + неподписанный overlay». Отсюда вердикт
   Defender вида «программа выполняет команды злоумышленников».
2. **Каждый пользователь получает УНИКАЛЬНЫЙ бинарь.** Хвост у всех разный →
   хэш файла уникален → нулевая «репутация» в SmartScreen. Подписанный или нет —
   репутация по хэшу не накапливается, предупреждение показывается каждому.
3. **APK ломается.** У APK подпись/`zip central directory` в конце; дозапись
   хвоста после неё делает архив «битым/подделанным» → установка отклоняется,
   Play Protect ругается. (Поэтому в продукте привязка Android — через deep-link
   `smartstock://bind?token=...`, а APK не модифицируется.)

Подпись кода (EV/OV сертификат) проблему exe убирает, но это **деньги и юрлицо**,
а наличие overlay всё равно повышает риск эвристик.

## На что заменили в продукте (sidecar)

Сервер отдаёт **ZIP** с двумя файлами рядом:

```
SmartStock/
  SmartStock.exe      ← НЕИЗМЕНЁННЫЙ базовый бинарь (хэш стабилен у всех)
  manifest.json       ← персональные настройки (адрес, роль, bindingToken, модули)
  ЧИТАЙ.txt
```

Клиент на старте читает `manifest.json` **из своего каталога** (рядом с exe), а
не из собственного хвоста. Реализация: `ConfigReader::readSidecar()` в десктопе
(с откатом к чтению «хвоста» для уже розданных сборок) и `buildZip()` на сервере
(`packages/api/src/modules/builder/zip.ts`).

Плюсы:
- базовый exe у всех байт-в-байт одинаковый → можно один раз подписать и копить
  репутацию SmartScreen;
- нет overlay → нет «дроппер-эвристики»;
- APK не трогаем — устанавливается штатно.

Минус: пользователь получает ZIP, а не один файл — нужно распаковать папку
целиком (поэтому в архиве лежит `ЧИТАЙ.txt`).

## Почему код «хвоста» сохранён здесь

Техника сама по себе **легальна и полезна** (персонализация без перекомпиляции
за миллисекунды, без тулчейна на сервере) и применима там, где антивирусная
репутация конечного бинаря не критична: внутренние инструменты, CI-артефакты,
Linux/macOS-сборки, киоски, образы. CRC32 — zlib-совместимый, ридер легко
написать на C/C++. Поэтому `@smartstack/installer-glue` остаётся в опенсорсе
как есть — это референсная реализация приёма, а не «удалённый мусор».

---

# EN — Why the tail-glue was removed from the product (but kept here)

The `installer-glue` trick (appending a config **overlay** to the end of a
prebuilt `.exe`/`.apk`) works, but it **triggers antivirus false positives**:
appending data after a PE and reading your own file at startup is a classic
dropper pattern, so Windows Defender/SmartScreen (and Yandex download checks)
flag it ("the program executes attacker commands"). Each user also gets a unique
binary hash → zero SmartScreen reputation. For APK the overlay breaks the zip
central directory, so Android refuses to install it.

The product now ships a **sidecar**: an unmodified `SmartStock.exe` plus a
`manifest.json` next to it, packed in a ZIP. The base binary is byte-identical
for everyone (sign once, build reputation), there is no overlay heuristic, and
the APK is left untouched (binding via `smartstock://bind` deep-link).

The tail technique is **legitimate and useful** where end-binary AV reputation
doesn't matter (internal tools, CI artifacts, Linux/macOS builds, kiosks). So we
keep this package as a clean reference implementation rather than deleting it.
