# Smartstack Messenger — E2E wire format (CRYPTO)

This document specifies the exact end-to-end encryption format so that any
client (web `tweetnacl`, Qt `libsodium`, or a third-party implementation) can
interoperate. The server never sees plaintext: it stores ciphertext blobs and
public keys only.

## 1. Key pairs

Each user has a Curve25519 key pair (NaCl `box` / libsodium `crypto_box`).

- **Public key**: 32 bytes, base64-encoded, published to the server via
  `PUT /api/v1/messenger/chat/keys` `{ "publicKey": "<base64>" }`. Stored in
  `messenger_users.public_key`.
- **Secret key**: 32 bytes. **Never leaves the device.**
  - Web client: persisted in `localStorage` as base64 `{ pk, sk }`.
  - Qt client: persisted to a local key file `base64(pk)\nbase64(sk)`.

Generation:
- Web: `nacl.box.keyPair()`
- Qt: `crypto_box_keypair(pk, sk)`

Both produce X25519 keys — fully interoperable.

## 2. Message box (`e2e:` value)

A single ciphertext is the authenticated NaCl `box`
(X25519 key agreement + XSalsa20-Poly1305) of the plaintext, with a random
24-byte nonce prepended, then base64, then prefixed with the literal `e2e:`.

```
value = "e2e:" + base64( nonce(24 bytes) || box )
box   = crypto_box_easy(plaintext, nonce, recipientPubKey, senderSecretKey)
```

- `box` length = `plaintext.length + 16` (16 = Poly1305 MAC, `crypto_box_MACBYTES`).
- Decryption: strip `e2e:`, base64-decode, split first 24 bytes as nonce, the
  rest is the box; `crypto_box_open_easy(box, nonce, senderPubKey, mySecretKey)`.
- A value that does **not** start with `e2e:` is treated as plaintext / legacy
  and returned as-is.

Web ↔ Qt: `nacl.box` and `crypto_box_easy` are the same primitive with the same
nonce/MAC layout, so a value produced by one decrypts in the other.

## 3. Group envelope (per-recipient)

There is no shared group key. Each message is encrypted **once per recipient**
(including the sender, so they can read their own history) using that
recipient's public key. The transported message `body` is JSON:

```json
{
  "g": 1,
  "e": {
    "<userId-1>": "e2e:base64(nonce+box)",
    "<userId-2>": "e2e:base64(nonce+box)",
    "<senderUserId>": "e2e:base64(nonce+box)"
  }
}
```

- `g`: format/version marker (`1`).
- `e`: map of recipient `messengerUserId` → that recipient's `e2e:` box of the
  same plaintext payload.
- Decryption: the reader looks up its own `userId` in `e`, then opens that box
  with the **sender's** public key and its own secret key. If there is no entry
  for the reader, the message is undecryptable for them (returns `null`).
- Sender's own public key is used when `senderId === me.id`.
- 1-on-1 conversations may use either the envelope or a bare `e2e:` value
  (legacy direct form); a `body` that does not start with `{` is decrypted as a
  bare `e2e:` value against the other party's public key.

The plaintext payload inside each box is the application payload string — for a
text message this is just the message text; for a file it is the JSON described
below.

## 4. File attachments (hybrid: secretbox + envelope)

Files are encrypted once with a random symmetric key, uploaded as an opaque
blob, and the symmetric key is distributed to recipients inside the message
envelope.

1. Generate a random 32-byte key `K` and a random 24-byte nonce.
2. Symmetric encrypt the file bytes: NaCl `secretbox` (XSalsa20-Poly1305).
   ```
   blob = nonce(24 bytes) || secretbox(fileBytes, nonce, K)
   ```
   (`secretbox` adds a 16-byte MAC, `crypto_secretbox_MACBYTES`.)
3. Upload `blob` as the attachment (multipart) →
   `POST /api/v1/messenger/chat/conversations/:id/attachments` → `{ key, ... }`.
   The server stores it under `messenger/<conversationId>/<uuid>_<name>` and
   never has `K`.
4. Send a normal message whose envelope payload (per §3) is the JSON:
   ```json
   { "name": "<original filename>", "k": "<base64 of K>" }
   ```
   plus the attachment `key` in the message's `attachmentUrl` field.
5. A recipient opens the envelope to recover `{ name, k }`, downloads the blob
   via `GET /api/v1/messenger/chat/attachments/download?key64=<base64url(key)>`,
   splits off the 24-byte nonce, and `secretbox_open`s the rest with `K`.

Web (`nacl.secretbox`) and Qt (`crypto_secretbox_easy`) are identical, so file
blobs are interoperable.

## 5. What the server can and cannot see

- **Can see**: public keys, who is in a conversation, message timestamps,
  ciphertext sizes (mitigated by padding, см. §7.2), attachment blob sizes.
- **Cannot see**: message plaintext, file plaintext, any symmetric key —
  all secret/file keys stay on devices; the server only relays ciphertext.
- **Больше НЕ видит автора каждого сообщения** — с sealed-sender (§7.1) отправка
  идёт без токена личности, `sender_id` не сохраняется (NULL).

## 6. Primitive summary

| Purpose            | Primitive                         | Web (tweetnacl)   | Qt (libsodium)            |
|--------------------|-----------------------------------|-------------------|---------------------------|
| Key pair           | X25519                            | `nacl.box.keyPair`| `crypto_box_keypair`      |
| Message box        | X25519 + XSalsa20-Poly1305        | `nacl.box`        | `crypto_box_easy`         |
| File body          | XSalsa20-Poly1305 (secret key)    | `nacl.secretbox`  | `crypto_secretbox_easy`   |
| Nonce size         | 24 bytes                          | `nacl.randomBytes`| `randombytes_buf`         |
| MAC size           | 16 bytes                          | (built in)        | `crypto_box_MACBYTES`     |

## 7. Приватность метаданных (sealed-sender, «вариант 1»)

Сверх E2E-шифрования содержимого мы прячем и часть метаданных. Это реализация
идеи «3 пакета»: получатель сам определяет, кому адресовано и от кого, пробуя
расшифровать конверт своим ключом (NaCl box — аутентифицированный).

### 7.1 Sealed-sender — сервер не знает автора

- У диалога есть **общий секрет постинга** (`post_secret`). Участник получает его
  authed-запросом `GET …/conversations/:id/post-token` (тут личность ещё видна).
- Отправка идёт на `POST …/conversations/:id/sealed-messages` **без токена
  личности** — авторизация секретом диалога в теле (`postToken`). Сервер
  сохраняет сообщение с `sender_id = NULL` → **не знает, кто из участников
  написал**. Личность отправителя — внутри E2E-payload; её узнаёт только
  получатель по тому, чьим ключом расшифровался конверт.
- Секрет сравнивается в постоянном времени (`timingSafeEqual`).

### 7.2 Padding — прячем длину

Текст добивается пробелами до бакетов `[128, 512, 2048, 8192, 32768, 131072]`
символов (UTF-16 code units — совпадает в JS `String.length` и Qt
`QString::length`), формат `"P1\n<len>\n<text><пробелы>"`. Сервер видит только
размер бакета, не реальную длину. Старые сообщения без маркера `P1\n` читаются
как есть (обратная совместимость).

### 7.3 Реакции и файлы как sealed-сообщения

- **Реакции** — sealed-сообщения с `type='react'` и E2E-payload `{m:targetId,
  e:emoji}`. Сервер не видит ни эмодзи, ни цель, ни автора; реакции не двигают
  диалог вверх и не попадают в превью (фильтр `type='msg'`).
- **Файлы** — гибрид: случайный ключ шифрует файл, ключ заворачивается на каждого
  получателя. Загрузка/скачивание — sealed (по секрету диалога): заголовки
  `x-post-token` и `x-att-key`, ключ НЕ в URL → не оседает в логах.

### 7.4 Без read-receipt, без IP

- **Read-receipt убран**: непрочитанное считает КЛИЕНТ (`localRead` в
  localStorage), сервер не узнаёт факт прочтения. Серверный счётчик `unread` —
  best-effort (при sealed-отправке автор неизвестен).
- **IP не логируется**: req-сериализатор оставляет только метод и путь.

### 7.5 Отпечатки ключей (safety numbers)

Защита от MITM-подмены публичного ключа: `SHA-512(pubkey)`, первые 16 байт hex —
участники сверяют отпечаток вне канала. Web — `keyFingerprint()`/`showSafety()`,
Qt — `QCryptographicHash::Sha512`.

### 7.6 Технические флаги одним числом (MsgFlags)

«Технические флаги» сообщения (вид: текст/файл/реакция/голос/системное; ответ-ли;
правка; удаление) упаковываются в **одно 64-битное число** и разбираются битовыми
операциями — это компактнее набора JSON-ключей (со всего потока расшифровывает лишь
адресат, но флаги распаковывают все) и быстрее на C++.

Раскладка (LSB→MSB), общая для Qt и веба:

```
биты  0..7  kind   — 0 Text, 1 File, 2 React, 3 Voice, 4 System
бит   8     reply  — ответ на сообщение
бит   9     edit   — правка
бит   10    delete — техническое «удалить»
биты 11..63 резерв
```

Реализация: C++ — `desktop/src/MsgFlags.hpp` (всё `constexpr`, раскладка проверяется
`static_assert` при сборке — нулевая цена в рантайме); JS — объект `MsgFlags` в
`web/index.html` (мини-самопроверка через `console.assert`). Поле `f` кладётся в
E2E-payload структурных сообщений (файл/реакция) — аддитивно и обратносовместимо
(старые сообщения без `f` разбираются прежней логикой).

### 7.7 Реал-тайм (SSE) не раскрывает метаданные

Мгновенная доставка сделана на Server-Sent Events, и она **не ослабляет** sealed-sender:

- Сервер шлёт участникам диалога **«пинг»** только `{ type, conversationId }` — **без
  контента и без автора**. По пингу клиент сам тянет sealed-сообщения (как при опросе),
  поэтому автор по-прежнему определяется лишь trial-decrypt'ом на устройстве (§7.1).
  Сервер раскрывает не больше, чем и так знает (состав диалога — §«Что осталось видно»).
- **Токен не попадает в URL** (URL оседает в логах/истории): EventSource умеет только
  GET без заголовков, поэтому клиент берёт **одноразовый короткоживущий тикет**
  (`POST …/chat/events/ticket`) и передаёт его в `GET …/chat/events?ticket=…`.
- Реализация: `server/src/messenger/events.ts` (`EventHub` + `TicketStore`),
  эмиссия в `routes.ts` после отправки. Шина — в памяти процесса (одна реплика);
  для нескольких реплик — Postgres `LISTEN/NOTIFY`/Redis.

### Что осталось серверу видно

Состав диалога и время доставки (нужны, чтобы доставить адресату) — убирается
только mix-сетью/onion (не реализовано; см. «вариант 2» в плане). Это
осознанный компромисс: мессенджер остаётся быстрым и лёгким.

> **Статус реализации:** серверная часть (sealed-эндпоинты, `post_secret`,
> `type`, nullable `sender_id`, без IP-логов) — в этом репозитории. Клиентская
> часть (trial-decrypt, padding, отпечатки в `web/index.html` и Qt) переносится
> из основного продукта SmartStock — см. roadmap в README. Legacy authed-роуты
> (`…/messages`) сохранены, поэтому существующие клиенты продолжают работать.
