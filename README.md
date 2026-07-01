# Smartstack — open-source модули

Открытые, самостоятельные части, выделенные из проекта **SmartStock** (гибридная
распределённая ERP + мессенджер, ~140k строк). Каждый модуль автономен, со своей
лицензией MIT, своим README и тестами — берите по отдельности.

🌐 **Сайт проекта:** <https://ambassadorofcplusplus.github.io/smartstock-web/>

> Short EN: reusable open-source pieces extracted from the SmartStock project —
> a self-hosted E2E messenger, a batch (FIFO/LIFO/avg) write-off engine, an
> executable-gluing tool, and marketplace adapters. Each is standalone, MIT.

## Модули

| Модуль | Что это | Стек | Статус |
|---|---|---|---|
| [**messenger/**](messenger/) | Самостоятельный **E2E-мессенджер**: сервер + веб-клиент + нативный Qt-клиент. Группы, файлы, сквозное шифрование (приватный ключ не покидает устройство), веб↔Qt совместимы, **реал-тайм доставка по SSE** (приватный «пинг» без контента/автора — sealed-sender цел; токен не в URL). | Node/Fastify/Prisma · vanilla JS (tweetnacl) · Qt6/libsodium | ✅ 27/27 тестов |
| [**writeoff-engine/**](writeoff-engine/) | **Движок партионного учёта**: списание по партиям FIFO / LIFO / средневзвешенная, **резервы под заказ** (`ReservationService`: reserve/confirm/cancel/expire, FIFO), возвраты и корректировки. Storage-agnostic (свой `BatchStore`). | TypeScript (+ C++ оригинал в `cpp-reference/`) | ✅ 26/26 тестов |
| [**installer-glue/**](installer-glue/) | **Склейка установщика**: дописывает в конец готового `base.exe` хвост с манифестом/файлами → персональный установщик за миллисекунды, без перекомпиляции. **`extractTo`** (распаковка с защитой от path-traversal) + **sidecar-режим** + CLI `extract`. Lib + CLI. | Node.js (только builtins) | ✅ 26/26 тестов |
| [**marketplace-adapters/**](marketplace-adapters/) | **Адаптеры маркетплейсов** (FBS): Wildberries / Ozon / Yandex.Market / Sber — выгрузка остатков и цен, импорт заказов, **импорт финансов** (WB Statistics / Ozon transactions + парсеры файлов кабинета, `finance.ts`). HTTP-клиент инъектируется, ключи продавца не хранятся в библиотеке. | TypeScript (zero runtime deps) | ✅ 55/55 тестов |
| [**warehouse-navigator/**](warehouse-navigator/) | **Навигация по складу** «доведи до товара» без GPS: QR-якоря + AR/PDR (компас-гиро фьюжн, шаг по Вайнбергу, отсев магнитных аномалий, map-matching по плану, **выправление стрелки по 3D-плану**, **оптическо-инерциальная фузия** — оптика выправляет дрейф PDR, **ZUPT гиро-bias + калибровка шага по якорям**, **маршрут по нескольким товарам — pick-list**). Мобильный **APK** + **ПК-клиент** (Qt) + LAN-сервер; только склад/ячейки/товар/навигатор. | TS-ядро (zero-deps) · Node LAN-сервер · Expo RN · Qt6/C++ | ✅ ядро 137/137 · сервер 12/12 · mobile typecheck · Qt собирается |
| [**sync-engine/**](sync-engine/) | **Offline-first синхронизация** (референс-дизайн + ядро): журнал событий, идемпотентность по UUID, vector clocks, gap-free pull (xmin-горизонт), 2 типа конфликтов; **актуальный реле-стек** (E2E-кодек AES-256-GCM, транспорт реле, дедуп по op_id, оркестратор по ts-курсору) рядом с legacy serverSeq-моделью. | TypeScript (ядро) + [DESIGN.md](sync-engine/docs/DESIGN.md) + оригинал в `reference/` | ✅ 71/71 тестов |
| [**ai-toolcalling/**](ai-toolcalling/) | **Локальный LLM с tool-calling для C++**: приноси свою модель (`IGenerator`) и свои инструменты (`ToolRegistry`) — ядро даёт терпимый парсер форматов вызова мелких моделей, детерминированный агент-цикл (модель предлагает → исполняешь ты), снятие `<think>`, сборку промпта, **нативные протоколы** (Hammer/Mistral/Llama/Hermes/LFM) и **устойчивый агент-цикл** (лимиты/кэш/отмена/`sanitizeAnswer`). Header-only, model-agnostic. + [исследование 13 локальных моделей](ai-toolcalling/docs/RESEARCH.md). | C++17 header-only · nlohmann/json | ✅ 45/45 тестов |

## Почему это интересно
- **План-протокол против конфабуляции** — слабые локальные LLM не «вызывают функции
  сами» (выдумывают), а отдают JSON-план, который исполняет детерминированный код
  против авторитетного реестра. См. [`ai-toolcalling/docs/DESIGN.md`](ai-toolcalling/docs/DESIGN.md).
- **E2E-крипта, совместимая между платформами** — один формат `crypto_box`/`secretbox`
  работает и в вебе (tweetnacl), и в нативном Qt (libsodium); групповой
  «пер-получательский конверт», гибрид для файлов. См. [`messenger/docs/CRYPTO.md`](messenger/docs/CRYPTO.md).
- **Склейка вместо пересборки** — необычный приём доставки персональных сборок.
- **Движок учёта без БД** — алгоритм отделён от хранилища интерфейсом.

## Лицензия
MIT (см. [LICENSE](LICENSE)). Извлечено из проекта SmartStock; модули можно
использовать независимо.
