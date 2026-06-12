# Smartstack Messenger

> **Self-hosted, end-to-end encrypted messenger.** Web client + native Qt
> desktop client, 1-on-1 and group chats, encrypted file attachments. The
> server only ever relays ciphertext — private keys never leave the device.
> MIT licensed.

This project was extracted from the SmartStock project as a standalone,
self-contained messenger. It does **not** depend on the SmartStock ERP — only
the messenger feature, fully decoupled.

---

## Что это

Самостоятельный **сквозно-шифрованный (E2E) мессенджер**, который вы хостите
сами. В комплекте:

- **Сервер** (Node.js 20, Fastify v4, Prisma + PostgreSQL) — реестр аккаунтов,
  диалоги, хранение зашифрованных сообщений и вложений. Сервер видит только
  шифротекст и публичные ключи.
- **Веб-клиент** (`web/index.html`) — один статичный файл, шифрование на
  `tweetnacl`. Можно открыть прямо в браузере, указав адрес сервера.
- **Десктоп-клиент** (`desktop/`, C++/Qt, шифрование на `libsodium`).

Возможности: 1-на-1 и **групповые** чаты, **зашифрованные файлы**, поиск
контактов по короткому ключу/имени, лимит аккаунтов на инстанс.

## Архитектура

```
   Веб-клиент (tweetnacl)        Qt-клиент (libsodium)
        │  e2e:base64(nonce+box) / конверт { g,e }      │
        └───────────────┬───────────────────────────────┘
                        ▼
            Сервер синхронизации (Fastify + Prisma)
            - реестр аккаунтов (admin-токен)
            - токены мессенджера (JWT, kind='messenger')
            - диалоги/группы/сообщения (только шифротекст)
            - вложения (локальный диск или MinIO/S3)
                        │
                  PostgreSQL  (+ опц. MinIO)
```

Сервер НЕ хранит и НЕ видит ни приватных ключей, ни открытого текста — только
публичные ключи и зашифрованные тела сообщений/файлов.

## E2E в двух словах

- Пара ключей **X25519** на каждого пользователя. Публичный ключ публикуется на
  сервер; **приватный никогда не покидает устройство** (localStorage в вебе,
  файл ключа в Qt).
- Сообщение шифруется в `crypto_box` (X25519 + XSalsa20-Poly1305). Формат на
  проводе: `e2e:base64(nonce(24) + box)`.
- Группы — **конверт на каждого получателя**: одно и то же сообщение шифруется
  публичным ключом каждого участника; тело = JSON `{"g":1,"e":{"<userId>":"e2e:..."}}`.
- Файлы — **гибрид**: файл шифруется случайным ключом `K` через `secretbox`
  (blob = `nonce + secretbox`), а сам `K` кладётся в конверт-payload
  `{name,k}` рядом с сообщением.
- Веб (`tweetnacl`) и Qt (`libsodium`) используют одни и те же примитивы и
  совместимы между собой.

Полная спецификация формата — [`docs/CRYPTO.md`](docs/CRYPTO.md).

## Приватность метаданных (sealed-sender)

Сверх E2E содержимого прячем и метаданные (идея «3 пакета» — получатель сам
определяет адресата/автора, пробуя расшифровать конверт своим ключом):

- **Sealed-sender** — сервер **не знает автора** сообщения. Отправка идёт по
  общему секрету диалога без токена личности; `sender_id` не сохраняется (NULL).
- **Padding** длины сообщений до бакетов — сервер не видит реальную длину.
- **Реакции и файлы** — тоже sealed-сообщения (`type`), без личности; ключ
  вложения передаётся заголовком, не в URL (не оседает в логах).
- **Без read-receipt** (непрочитанное считает клиент) и **без логирования IP**.
- **Отпечатки ключей** (safety numbers) — сверка от MITM.

Подробно — [`docs/CRYPTO.md` §7](docs/CRYPTO.md).

> **Статус:**
> - **Сервер** — готов (эндпоинты `…/post-token`, `…/sealed-messages`,
>   `…/sealed-attachments`, поле `post_secret`, `type`, nullable `sender_id`,
>   отключённый IP-лог; миграция `0002_sealed_sender`).
> - **Веб-клиент** (`web/index.html`) — **готов**: sealed-отправка, trial-decrypt
>   отправителя, padding, sealed-файлы, **реакции-смайлики** (sealed `type='react'`,
>   пикер + чипы), отпечатки ключей (кнопка 🔐), локальный подсчёт непрочитанного
>   (без read-receipt). Крипто (tweetnacl) — **self-hosted** (`vendor/`, SRI), не с CDN.
> - **Qt-клиент** (`desktop/`) — **готов и СОБРАН** (Release, MSVC + Qt 6.5.3 +
>   libsodium, E2E ON): padPayload/unpad, decMessage trial-decrypt, `postSealed` без
>   auth-заголовка, **sealed-вложения** (x-post-token / x-att-key), отпечатки + кнопка
>   🔐, без read-receipt.
>
> Legacy authed-роуты (`…/messages`) сохранены → старые клиенты работают без изменений.

## Быстрый старт

### Вариант A — Docker Compose

```bash
cd server
cp .env.example .env          # при желании поправьте JWT_SECRET / ADMIN_TOKEN
docker compose up --build
```

Поднимет PostgreSQL и сервер (применит миграции автоматически). Сервер — на
`http://localhost:3000`.

### Вариант B — локально

```bash
cd server
cp .env.example .env
# отредактируйте .env: DATABASE_URL, JWT_SECRET, ADMIN_TOKEN
npm install
npm run prisma:generate
npx prisma migrate deploy     # применить миграции к вашей БД
npm run dev                   # tsx watch (или npm run build && npm start)
```

### Создать первого пользователя

Аккаунты создаёт администратор по токену `ADMIN_TOKEN` (заголовок
`Authorization: Bearer <ADMIN_TOKEN>`):

```bash
curl -X POST http://localhost:3000/api/v1/messenger/users \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# → { "id": "...", "messengerId": "ABCD2345" }
```

Полученный `messengerId` — ключ. Человек регистрируется по нему
(`POST /api/v1/messenger/register` с именем и паролем), затем входит
(`POST /api/v1/messenger/login`) и получает токен мессенджера.

### Веб-клиент

Откройте `web/index.html` в браузере (или раздайте папку `web/` любым
статик-сервером) и укажите адрес сервера (`http://localhost:3000`).

### Десктоп-клиент (Qt)

```bash
cd desktop
cmake -B build -DSSM_E2E=ON      # требуется Qt6 + libsodium
cmake --build build
```

Упаковка под Windows — см. `desktop/packaging/` (NSIS).

## Эндпоинты API

| Метод  | Путь                                                  | Доступ        | Назначение |
|--------|-------------------------------------------------------|---------------|------------|
| GET    | `/api/v1/health/live`                                 | —             | Health-check |
| GET    | `/api/v1/messenger/users`                             | admin-токен   | Список аккаунтов |
| POST   | `/api/v1/messenger/users`                             | admin-токен   | Создать аккаунт → `{messengerId}` |
| DELETE | `/api/v1/messenger/users/:id`                         | admin-токен   | Удалить аккаунт |
| GET    | `/api/v1/messenger/capacity`                          | admin-токен   | Лимит / занято / оценка ресурсов |
| PUT    | `/api/v1/messenger/limit`                             | admin-токен   | Изменить лимит `{limit}` |
| GET    | `/api/v1/messenger/publish`                           | admin-токен   | Статус публичного туннеля |
| POST   | `/api/v1/messenger/register`                          | публично      | Регистрация по ключу |
| POST   | `/api/v1/messenger/login`                             | публично      | Вход → токен мессенджера |
| PUT    | `/api/v1/messenger/chat/keys`                         | токен мессенджера | Опубликовать публичный ключ |
| GET    | `/api/v1/messenger/chat/contacts`                     | токен мессенджера | Поиск контактов |
| GET    | `/api/v1/messenger/chat/conversations`                | токен мессенджера | Список диалогов |
| POST   | `/api/v1/messenger/chat/conversations`                | токен мессенджера | Создать 1-на-1 диалог |
| POST   | `/api/v1/messenger/chat/groups`                       | токен мессенджера | Создать группу |
| POST   | `/api/v1/messenger/chat/conversations/:id/members`    | токен мессенджера | Добавить участника |
| GET    | `/api/v1/messenger/chat/conversations/:id/messages`   | токен мессенджера | История сообщений |
| POST   | `/api/v1/messenger/chat/conversations/:id/messages`   | токен мессенджера | Отправить сообщение |
| POST   | `/api/v1/messenger/chat/conversations/:id/read`       | токен мессенджера | Пометить прочитанным |
| POST   | `/api/v1/messenger/chat/conversations/:id/attachments`| токен мессенджера | Загрузить вложение |
| GET    | `/api/v1/messenger/chat/attachments/download`         | токен мессенджера | Скачать вложение |

## Структура

```
.
├── README.md  LICENSE  .gitignore
├── docs/CRYPTO.md            спецификация E2E-формата
├── server/                  Node.js + Fastify + Prisma
│   ├── package.json  tsconfig.json  .env.example
│   ├── Dockerfile  docker-compose.yml
│   ├── prisma/schema.prisma  prisma/migrations/...
│   └── src/                 app.ts, index.ts, messenger/*, lib/*
├── web/index.html           статичный веб-клиент (tweetnacl)
└── desktop/                 Qt-клиент (libsodium) + упаковка
```

## Лицензия

MIT. См. [LICENSE](LICENSE).

> Извлечено из проекта SmartStock как самостоятельный продукт.
