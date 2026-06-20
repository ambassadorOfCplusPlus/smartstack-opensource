#include "NavServer.hpp"

#include <QTcpSocket>
#include <QNetworkInterface>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QUrl>
#include <QUrlQuery>

namespace whnav {

NavServer::NavServer(QObject* parent) : QObject(parent) {
    connect(&m_server, &QTcpServer::newConnection, this, &NavServer::onNewConnection);
}

bool NavServer::start(quint16 port) {
    if (m_server.isListening()) return true;
    // QHostAddress::Any — слушаем на всех интерфейсах (телефон по LAN).
    const bool ok = m_server.listen(QHostAddress::Any, port);
    if (ok) emit log(QStringLiteral("Сервер запущен на порту %1").arg(m_server.serverPort()));
    else emit log(QStringLiteral("Не удалось занять порт %1: %2").arg(port).arg(m_server.errorString()));
    return ok;
}

void NavServer::stop() {
    if (m_server.isListening()) {
        m_server.close();
        emit log(QStringLiteral("Сервер остановлен"));
    }
}

QStringList NavServer::lanAddresses() {
    QStringList out;
    for (const QHostAddress& a : QNetworkInterface::allAddresses()) {
        if (a.protocol() == QAbstractSocket::IPv4Protocol && !a.isLoopback())
            out << a.toString();
    }
    return out;
}

void NavServer::onNewConnection() {
    while (QTcpSocket* sock = m_server.nextPendingConnection()) {
        connect(sock, &QTcpSocket::readyRead, this, [this, sock]() {
            // Ждём конец заголовков. Для GET/OPTIONS тела нет — этого достаточно.
            const QByteArray buf = sock->peek(8192);
            const int end = buf.indexOf("\r\n\r\n");
            if (end < 0) return;
            const QByteArray head = buf.left(end);
            const QString firstLine = QString::fromUtf8(head.left(head.indexOf("\r\n")));
            const QStringList parts = firstLine.split(' ');
            const QString method = parts.value(0);
            const QString path = parts.value(1);
            handleRequest(sock, method, path);
        });
        connect(sock, &QTcpSocket::disconnected, sock, &QObject::deleteLater);
    }
}

void NavServer::handleRequest(QTcpSocket* sock, const QString& method, const QString& path) {
    const QByteArray cors =
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type\r\n";

    if (method == "OPTIONS") {
        sock->write("HTTP/1.1 204 No Content\r\n" + cors + "Content-Length: 0\r\n\r\n");
        sock->disconnectFromHost();
        return;
    }

    int status = 200;
    const QByteArray body = route(method, path, status);
    const QByteArray reason = status == 200 ? "OK" : (status == 404 ? "Not Found" : "Bad Request");
    QByteArray resp = "HTTP/1.1 " + QByteArray::number(status) + " " + reason + "\r\n";
    resp += "Content-Type: application/json; charset=utf-8\r\n";
    resp += cors;
    resp += "Content-Length: " + QByteArray::number(body.size()) + "\r\n\r\n";
    resp += body;
    sock->write(resp);
    sock->disconnectFromHost();
    emit log(QStringLiteral("%1 %2 → %3").arg(method, path).arg(status));
}

QByteArray NavServer::route(const QString& method, const QString& rawPath, int& status) {
    if (!m_provider || method != "GET") {
        status = 404;
        return R"({"error":"NotFound"})";
    }
    const QUrl url(rawPath);
    const QString path = url.path();
    const QUrlQuery query(url);
    const QStringList seg = path.split('/', Qt::SkipEmptyParts); // ["api","warehouses",...]

    if (seg.value(0) != "api") {
        status = 404;
        return R"({"error":"NotFound"})";
    }
    const Snapshot snap = m_provider();

    // GET /api  (health)
    if (seg.size() == 1) return R"({"ok":true})";

    // GET /api/warehouses
    if (seg.size() == 2 && seg[1] == "warehouses") {
        QJsonArray a;
        a.append(QJsonObject{{"id", snap.warehouse.id}, {"name", snap.warehouse.name}});
        return QJsonDocument(QJsonObject{{"warehouses", a}}).toJson(QJsonDocument::Compact);
    }

    // GET /api/products?search=
    if (seg.size() == 2 && seg[1] == "products") {
        QJsonArray a;
        for (const auto& p : snap.searchProducts(query.queryItemValue("search"))) {
            a.append(QJsonObject{
                {"id", p.id}, {"sku", p.sku}, {"name", p.name},
                {"barcode", p.barcode.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(p.barcode)}});
        }
        return QJsonDocument(QJsonObject{{"products", a}}).toJson(QJsonDocument::Compact);
    }

    // /api/warehouses/:id/...
    if (seg.size() >= 4 && seg[1] == "warehouses") {
        const QString sub = seg[3];
        if (sub == "cells") {
            QJsonArray a;
            for (const auto& c : snap.cells) {
                a.append(QJsonObject{
                    {"id", c.id}, {"code", c.code}, {"warehouseId", c.warehouseId},
                    {"posXM", c.posXM ? QJsonValue(*c.posXM) : QJsonValue(QJsonValue::Null)},
                    {"posYM", c.posYM ? QJsonValue(*c.posYM) : QJsonValue(QJsonValue::Null)}});
            }
            return QJsonDocument(QJsonObject{{"cells", a}}).toJson(QJsonDocument::Compact);
        }
        if (sub == "layout") {
            QJsonArray racks;
            for (const auto& r : snap.layout) {
                racks.append(QJsonObject{
                    {"xM", r.xM}, {"yM", r.yM}, {"lengthM", r.lengthM}, {"widthM", r.widthM},
                    {"rotationDeg", r.rotationDeg}, {"kind", r.kind}});
            }
            return QJsonDocument(QJsonObject{{"layout", QJsonObject{{"racks", racks}}}})
                .toJson(QJsonDocument::Compact);
        }
        if (sub == "anchors") {
            QJsonArray a;
            for (const auto& an : snap.anchors) {
                a.append(QJsonObject{
                    {"warehouseId", an.warehouseId}, {"xM", an.xM}, {"yM", an.yM},
                    {"headingDeg", an.headingDeg}});
            }
            return QJsonDocument(QJsonObject{{"anchors", a}}).toJson(QJsonDocument::Compact);
        }
        if (sub == "product-location") {
            const QString pid = query.queryItemValue("productId");
            if (pid.isEmpty()) {
                status = 400;
                return R"({"error":"BadRequest","message":"productId обязателен"})";
            }
            QJsonArray a;
            for (const auto& l : snap.productLocation(pid)) {
                a.append(QJsonObject{
                    {"cellId", l.cellId}, {"code", l.code},
                    {"posXM", l.posXM ? QJsonValue(*l.posXM) : QJsonValue(QJsonValue::Null)},
                    {"posYM", l.posYM ? QJsonValue(*l.posYM) : QJsonValue(QJsonValue::Null)},
                    {"quantity", l.quantity}});
            }
            return QJsonDocument(QJsonObject{{"locations", a}}).toJson(QJsonDocument::Compact);
        }
        if (sub == "snapshot") {
            return snap.toJson(false);
        }
    }

    status = 404;
    return R"({"error":"NotFound"})";
}

} // namespace whnav
