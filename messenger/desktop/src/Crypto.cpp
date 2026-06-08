#include "Crypto.hpp"
#include <QFile>
#include <cstring>
#ifdef SSM_E2E
#include <sodium.h>
#endif

namespace {
const QString MARK = QStringLiteral("e2e:");
QString g_myPub;
#ifdef SSM_E2E
unsigned char g_pk[crypto_box_PUBLICKEYBYTES];
unsigned char g_sk[crypto_box_SECRETKEYBYTES];
bool g_loaded = false;
QByteArray b64d(const QString& s) { return QByteArray::fromBase64(s.toUtf8()); }
QString   b64e(const QByteArray& b) { return QString::fromUtf8(b.toBase64()); }
#endif
} // namespace

namespace Crypto {

bool available() {
#ifdef SSM_E2E
    return true;
#else
    return false;
#endif
}

bool init() {
#ifdef SSM_E2E
    return sodium_init() >= 0;
#else
    return false;
#endif
}

QString loadOrCreateKeys(const QString& keyFilePath) {
#ifdef SSM_E2E
    if (sodium_init() < 0) return {};
    QFile f(keyFilePath);
    if (f.exists() && f.open(QIODevice::ReadOnly)) {
        const QByteArray raw = f.readAll();
        f.close();
        const auto parts = raw.split('\n'); // base64(pk)\nbase64(sk)
        if (parts.size() >= 2) {
            const QByteArray pk = QByteArray::fromBase64(parts[0]);
            const QByteArray sk = QByteArray::fromBase64(parts[1]);
            if (pk.size() == crypto_box_PUBLICKEYBYTES && sk.size() == crypto_box_SECRETKEYBYTES) {
                std::memcpy(g_pk, pk.constData(), crypto_box_PUBLICKEYBYTES);
                std::memcpy(g_sk, sk.constData(), crypto_box_SECRETKEYBYTES);
                g_loaded = true;
                g_myPub = b64e(QByteArray(reinterpret_cast<char*>(g_pk), crypto_box_PUBLICKEYBYTES));
                return g_myPub;
            }
        }
    }
    crypto_box_keypair(g_pk, g_sk);
    g_loaded = true;
    g_myPub = b64e(QByteArray(reinterpret_cast<char*>(g_pk), crypto_box_PUBLICKEYBYTES));
    if (f.open(QIODevice::WriteOnly)) {
        f.write(QByteArray(reinterpret_cast<char*>(g_pk), crypto_box_PUBLICKEYBYTES).toBase64());
        f.write("\n");
        f.write(QByteArray(reinterpret_cast<char*>(g_sk), crypto_box_SECRETKEYBYTES).toBase64());
        f.close();
    }
    return g_myPub;
#else
    Q_UNUSED(keyFilePath);
    return {};
#endif
}

QString myPublicKey() { return g_myPub; }

QString encryptFor(const QString& recipientPubKeyB64, const QByteArray& plain) {
#ifdef SSM_E2E
    if (!g_loaded || recipientPubKeyB64.isEmpty()) return QString::fromUtf8(plain);
    const QByteArray rpk = b64d(recipientPubKeyB64);
    if (rpk.size() != crypto_box_PUBLICKEYBYTES) return QString::fromUtf8(plain);
    QByteArray nonce(crypto_box_NONCEBYTES, 0);
    randombytes_buf(nonce.data(), nonce.size());
    QByteArray cipher(plain.size() + crypto_box_MACBYTES, 0);
    if (crypto_box_easy(reinterpret_cast<unsigned char*>(cipher.data()),
                        reinterpret_cast<const unsigned char*>(plain.constData()), plain.size(),
                        reinterpret_cast<const unsigned char*>(nonce.constData()),
                        reinterpret_cast<const unsigned char*>(rpk.constData()), g_sk) != 0)
        return QString::fromUtf8(plain);
    return MARK + b64e(nonce + cipher);
#else
    Q_UNUSED(recipientPubKeyB64);
    return QString::fromUtf8(plain);
#endif
}

QByteArray decryptFrom(const QString& senderPubKeyB64, const QString& boxB64) {
#ifdef SSM_E2E
    if (!boxB64.startsWith(MARK)) return boxB64.toUtf8(); // не наш формат — отдать как есть
    if (!g_loaded || senderPubKeyB64.isEmpty()) return {};
    const QByteArray spk = b64d(senderPubKeyB64);
    if (spk.size() != crypto_box_PUBLICKEYBYTES) return {};
    const QByteArray raw = b64d(boxB64.mid(MARK.size()));
    if (raw.size() < static_cast<int>(crypto_box_NONCEBYTES + crypto_box_MACBYTES)) return {};
    const QByteArray nonce = raw.left(crypto_box_NONCEBYTES);
    const QByteArray cipher = raw.mid(crypto_box_NONCEBYTES);
    QByteArray plain(cipher.size() - crypto_box_MACBYTES, 0);
    if (crypto_box_open_easy(reinterpret_cast<unsigned char*>(plain.data()),
                             reinterpret_cast<const unsigned char*>(cipher.constData()), cipher.size(),
                             reinterpret_cast<const unsigned char*>(nonce.constData()),
                             reinterpret_cast<const unsigned char*>(spk.constData()), g_sk) != 0)
        return {};
    return plain;
#else
    Q_UNUSED(senderPubKeyB64);
    return boxB64.toUtf8();
#endif
}

bool isEncrypted(const QString& s) { return s.startsWith(MARK); }

QByteArray secretboxEnc(const QByteArray& plain, QString& outKeyB64) {
#ifdef SSM_E2E
    QByteArray key(crypto_secretbox_KEYBYTES, 0);
    randombytes_buf(key.data(), key.size());
    QByteArray nonce(crypto_secretbox_NONCEBYTES, 0);
    randombytes_buf(nonce.data(), nonce.size());
    QByteArray cipher(plain.size() + crypto_secretbox_MACBYTES, 0);
    if (crypto_secretbox_easy(reinterpret_cast<unsigned char*>(cipher.data()),
                              reinterpret_cast<const unsigned char*>(plain.constData()), plain.size(),
                              reinterpret_cast<const unsigned char*>(nonce.constData()),
                              reinterpret_cast<const unsigned char*>(key.constData())) != 0)
        return {};
    outKeyB64 = b64e(key);
    return nonce + cipher;
#else
    Q_UNUSED(plain); Q_UNUSED(outKeyB64); return {};
#endif
}

QByteArray secretboxDec(const QByteArray& blob, const QString& keyB64) {
#ifdef SSM_E2E
    const QByteArray key = b64d(keyB64);
    if (key.size() != crypto_secretbox_KEYBYTES ||
        blob.size() < static_cast<int>(crypto_secretbox_NONCEBYTES + crypto_secretbox_MACBYTES))
        return {};
    const QByteArray nonce = blob.left(crypto_secretbox_NONCEBYTES);
    const QByteArray cipher = blob.mid(crypto_secretbox_NONCEBYTES);
    QByteArray plain(cipher.size() - crypto_secretbox_MACBYTES, 0);
    if (crypto_secretbox_open_easy(reinterpret_cast<unsigned char*>(plain.data()),
                                   reinterpret_cast<const unsigned char*>(cipher.constData()), cipher.size(),
                                   reinterpret_cast<const unsigned char*>(nonce.constData()),
                                   reinterpret_cast<const unsigned char*>(key.constData())) != 0)
        return {};
    return plain;
#else
    Q_UNUSED(blob); Q_UNUSED(keyB64); return {};
#endif
}

} // namespace Crypto
