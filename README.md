# Smartstack — open-source модули

Открытые, самостоятельные части, выделенные из проекта **SmartStock** (гибридная
распределённая ERP + мессенджер, ~140k строк). Каждый модуль автономен, со своей
лицензией MIT, своим README и тестами — берите по отдельности.

> Short EN: reusable open-source pieces extracted from the SmartStock project —
> a self-hosted E2E messenger, a batch (FIFO/LIFO/avg) write-off engine, an
> executable-gluing tool, and marketplace adapters. Each is standalone, MIT.

## Модули

| Модуль | Что это | Стек | Статус |
|---|---|---|---|
| [**messenger/**](messenger/) | Самостоятельный **E2E-мессенджер**: сервер + веб-клиент + нативный Qt-клиент. Группы, файлы, сквозное шифрование (приватный ключ не покидает устройство), веб↔Qt совместимы. | Node/Fastify/Prisma · vanilla JS (tweetnacl) · Qt6/libsodium | ✅ 17/17 тестов |
| [**writeoff-engine/**](writeoff-engine/) | **Движок партионного учёта**: списание по партиям FIFO / LIFO / средневзвешенная, резервы, возвраты. Storage-agnostic (свой `BatchStore`). | TypeScript (+ C++ оригинал в `cpp-reference/`) | ✅ 14/14 тестов |
| [**installer-glue/**](installer-glue/) | **Склейка установщика**: дописывает в конец готового `base.exe` хвост с манифестом/файлами → персональный установщик за миллисекунды, без перекомпиляции. Lib + CLI. | Node.js (только builtins) | ✅ 7/7 тестов |
| [**marketplace-adapters/**](marketplace-adapters/) | **Адаптеры маркетплейсов** (FBS): Wildberries / Ozon / Yandex.Market / Sber — выгрузка остатков и цен, импорт заказов. HTTP-клиент инъектируется, ключи продавца не хранятся в библиотеке. | TypeScript (zero runtime deps) | ✅ 23/23 тестов |

## Почему это интересно
- **E2E-крипта, совместимая между платформами** — один формат `crypto_box`/`secretbox`
  работает и в вебе (tweetnacl), и в нативном Qt (libsodium); групповой
  «пер-получательский конверт», гибрид для файлов. См. [`messenger/docs/CRYPTO.md`](messenger/docs/CRYPTO.md).
- **Склейка вместо пересборки** — необычный приём доставки персональных сборок.
- **Движок учёта без БД** — алгоритм отделён от хранилища интерфейсом.

## Лицензия
MIT (см. [LICENSE](LICENSE)). Извлечено из проекта SmartStock; модули можно
использовать независимо.
