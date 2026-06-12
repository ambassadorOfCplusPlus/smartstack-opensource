#include "ApiClient.hpp"
#include <QNetworkAccessManager>
#include <QNetworkRequest>
#include <QNetworkReply>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QHttpMultiPart>
#include <QHttpPart>
#include <QFile>
#include <QFileInfo>
#include <QUrl>

ApiClient::ApiClient(QObject* parent) : QObject(parent), m_nam(new QNetworkAccessManager(this)) {}

QString ApiClient::url(const QString& path) const {
    QString base = m_base.trimmed();
    while (base.endsWith('/')) base.chop(1);
    const QString prefix = base.contains("/api/") ? "" : "/api/v1/messenger";
    return base + prefix + path;
}

void ApiClient::send(const QByteArray& verb, const QString& path, const QByteArray& body,
                     const QString& contentType, JsonCb cb, bool auth) {
    QNetworkRequest req{ QUrl(url(path)) };
    if (!contentType.isEmpty()) req.setHeader(QNetworkRequest::ContentTypeHeader, contentType);
    if (auth && !m_token.isEmpty()) req.setRawHeader("Authorization", "Bearer " + m_token.toUtf8());

    QNetworkReply* reply = m_nam->sendCustomRequest(req, verb, body);
    QObject::connect(reply, &QNetworkReply::finished, this, [reply, cb]() {
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const QByteArray data = reply->readAll();
        reply->deleteLater();
        const QJsonDocument doc = QJsonDocument::fromJson(data);
        const QJsonValue val = doc.isObject() ? QJsonValue(doc.object())
                              : doc.isArray() ? QJsonValue(doc.array()) : QJsonValue();
        const bool ok = status >= 200 && status < 300;
        if (cb) cb(ok, val, status);
    });
}

void ApiClient::get(const QString& path, JsonCb cb) { send("GET", path, {}, {}, std::move(cb)); }

void ApiClient::post(const QString& path, const QJsonObject& body, JsonCb cb) {
    send("POST", path, QJsonDocument(body).toJson(QJsonDocument::Compact), "application/json", std::move(cb));
}

void ApiClient::put(const QString& path, const QJsonObject& body, JsonCb cb) {
    send("PUT", path, QJsonDocument(body).toJson(QJsonDocument::Compact), "application/json", std::move(cb));
}

void ApiClient::postSealed(const QString& path, const QJsonObject& body, JsonCb cb) {
    // auth=false: без Authorization — авторизация секретом диалога в теле.
    send("POST", path, QJsonDocument(body).toJson(QJsonDocument::Compact), "application/json",
         std::move(cb), /*auth=*/false);
}

void ApiClient::uploadFile(const QString& path, const QString& filePath, JsonCb cb) {
    auto* mp = new QHttpMultiPart(QHttpMultiPart::FormDataType);
    auto* file = new QFile(filePath);
    if (!file->open(QIODevice::ReadOnly)) {
        delete file; delete mp;
        if (cb) cb(false, QJsonObject{{"message", "Не удалось открыть файл"}}, 0);
        return;
    }
    QHttpPart part;
    part.setHeader(QNetworkRequest::ContentDispositionHeader,
                   QVariant(QString("form-data; name=\"file\"; filename=\"%1\"")
                                .arg(QFileInfo(filePath).fileName())));
    part.setBodyDevice(file);
    file->setParent(mp);
    mp->append(part);

    QNetworkRequest req{ QUrl(url(path)) };
    if (!m_token.isEmpty()) req.setRawHeader("Authorization", "Bearer " + m_token.toUtf8());
    QNetworkReply* reply = m_nam->post(req, mp);
    mp->setParent(reply);
    QObject::connect(reply, &QNetworkReply::finished, this, [reply, cb]() {
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const QByteArray data = reply->readAll();
        reply->deleteLater();
        const QJsonDocument doc = QJsonDocument::fromJson(data);
        if (cb) cb(status >= 200 && status < 300, doc.object(), status);
    });
}

void ApiClient::downloadBin(const QString& path, BinCb cb) {
    QNetworkRequest req{ QUrl(url(path)) };
    if (!m_token.isEmpty()) req.setRawHeader("Authorization", "Bearer " + m_token.toUtf8());
    QNetworkReply* reply = m_nam->get(req);
    QObject::connect(reply, &QNetworkReply::finished, this, [reply, cb]() {
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const QByteArray data = reply->readAll();
        QString filename;
        const QByteArray cd = reply->rawHeader("Content-Disposition");
        const int idx = cd.indexOf("filename=");
        if (idx >= 0) {
            QByteArray rest = cd.mid(idx + 9);
            const int semi = rest.indexOf(';');   // отрезаем хвостовые параметры
            if (semi >= 0) rest = rest.left(semi);
            filename = QString::fromUtf8(rest).remove('"').trimmed();
        }
        reply->deleteLater();
        if (cb) cb(status >= 200 && status < 300, data, filename);
    });
}
