#pragma once
// E2E-крипто на libsodium (crypto_box, X25519 + XSalsa20-Poly1305).
// Приватный ключ хранится ТОЛЬКО локально (файл в данных приложения). Сервер
// получает лишь публичный ключ. Шифруем «мой приватный + публичный получателя».
//
// Если собрано без libsodium (SSM_E2E не задан) — функции работают как
// passthrough (без шифрования), чтобы клиент компилировался и в фазе 1.
#include <QString>
#include <QByteArray>

namespace Crypto {

// Скомпилировано ли с E2E (libsodium).
bool available();

// Инициализация libsodium. Безопасно вызывать многократно.
bool init();

// Загрузить пару ключей из файла, либо создать новую и сохранить. Возвращает
// свой публичный ключ (base64) или пустую строку при ошибке. Без E2E → "".
QString loadOrCreateKeys(const QString& keyFilePath);

// Свой публичный ключ (base64), после loadOrCreateKeys.
QString myPublicKey();

// Зашифровать для получателя (его публичный ключ base64). Возвращает
// base64(nonce + ciphertext). При отсутствии E2E/ключа — текст как есть (маркер).
QString encryptFor(const QString& recipientPubKeyB64, const QByteArray& plain);

// Расшифровать пришедшее от отправителя (его публичный ключ base64).
// boxB64 — base64(nonce+cipher). Возвращает открытый текст или пусто при ошибке.
QByteArray decryptFrom(const QString& senderPubKeyB64, const QString& boxB64);

// Зашифровано ли значение нашим форматом (есть префикс-маркер).
bool isEncrypted(const QString& s);

// Симметричное шифрование файла (для групп, «гибрид»): случайный ключ K шифрует
// содержимое один раз; K кладётся в конверт сообщения каждому участнику.
// secretboxEnc → blob (nonce+box), outKeyB64 = ключ (base64). Совместимо с
// nacl.secretbox в веб-клиенте.
QByteArray secretboxEnc(const QByteArray& plain, QString& outKeyB64);
QByteArray secretboxDec(const QByteArray& blob, const QString& keyB64);

} // namespace Crypto
