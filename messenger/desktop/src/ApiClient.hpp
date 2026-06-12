#pragma once
// HTTP-клиент мессенджера на QNetworkAccessManager. Все вызовы асинхронные, с
// колбэком. База: {serverUrl}/api/v1/messenger.
#include <QObject>
#include <QString>
#include <QJsonValue>
#include <QJsonObject>
#include <functional>

class QNetworkAccessManager;

class ApiClient : public QObject {
    Q_OBJECT
public:
    explicit ApiClient(QObject* parent = nullptr);

    void setServer(const QString& url) { m_base = url; }
    void setToken(const QString& t) { m_token = t; }
    QString token() const { return m_token; }
    QString server() const { return m_base; }

    // ok=false → ошибка (body может содержать {message}); status — HTTP-код.
    using JsonCb = std::function<void(bool ok, const QJsonValue& body, int status)>;
    using BinCb = std::function<void(bool ok, const QByteArray& data, const QString& filename)>;

    void get(const QString& path, JsonCb cb);
    void post(const QString& path, const QJsonObject& body, JsonCb cb);
    void put(const QString& path, const QJsonObject& body, JsonCb cb);
    // Sealed-sender: POST БЕЗ заголовка Authorization (личность не раскрывается —
    // авторизация секретом диалога в теле, postToken). Сервер не узнаёт автора.
    void postSealed(const QString& path, const QJsonObject& body, JsonCb cb);
    void uploadFile(const QString& path, const QString& filePath, JsonCb cb);
    void downloadBin(const QString& path, BinCb cb);
    // Sealed-вложения: без Authorization; авторизация секретом диалога в заголовке
    // x-post-token (загрузка) / x-att-key + x-post-token (скачивание, ключ не в URL).
    void uploadFileSealed(const QString& path, const QString& filePath,
                          const QString& postToken, JsonCb cb);
    void downloadBinSealed(const QString& path, const QString& attKey,
                           const QString& postToken, BinCb cb);

private:
    QNetworkAccessManager* m_nam;
    QString m_base;
    QString m_token;
    QString url(const QString& path) const;
    // auth=false → не добавляем Authorization (sealed-отправка).
    void send(const QByteArray& verb, const QString& path, const QByteArray& body,
              const QString& contentType, JsonCb cb, bool auth = true);
};
