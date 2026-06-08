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
  ciphertext sizes, attachment blob sizes/filenames-on-disk.
- **Cannot see**: message plaintext, file plaintext, or any symmetric key — all
  secret keys and file keys stay on devices; the server only relays ciphertext.

## 6. Primitive summary

| Purpose            | Primitive                         | Web (tweetnacl)   | Qt (libsodium)            |
|--------------------|-----------------------------------|-------------------|---------------------------|
| Key pair           | X25519                            | `nacl.box.keyPair`| `crypto_box_keypair`      |
| Message box        | X25519 + XSalsa20-Poly1305        | `nacl.box`        | `crypto_box_easy`         |
| File body          | XSalsa20-Poly1305 (secret key)    | `nacl.secretbox`  | `crypto_secretbox_easy`   |
| Nonce size         | 24 bytes                          | `nacl.randomBytes`| `randombytes_buf`         |
| MAC size           | 16 bytes                          | (built in)        | `crypto_box_MACBYTES`     |
