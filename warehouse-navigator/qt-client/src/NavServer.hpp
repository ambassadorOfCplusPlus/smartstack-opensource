// Встроенный LAN-сервер ПК-клиента: отдаёт телефону те же REST-эндпоинты, что и
// Node-сервер (../server), но прямо из текущего снимка склада в клиенте. Телефон в
// той же сети Wi-Fi подключается к адресу ПК. Минимальный HTTP поверх QTcpServer
// (только GET + CORS); данные берутся через колбэк, поэтому всегда актуальны.
#pragma once

#include <QObject>
#include <QTcpServer>
#include <functional>
#include "Snapshot.hpp"

namespace whnav {

class NavServer : public QObject {
    Q_OBJECT
public:
    explicit NavServer(QObject* parent = nullptr);

    // provider возвращает актуальный снимок при каждом запросе.
    void setProvider(std::function<Snapshot()> provider) { m_provider = std::move(provider); }

    bool start(quint16 port);
    void stop();
    bool isRunning() const { return m_server.isListening(); }
    quint16 port() const { return m_server.serverPort(); }

    // Локальные IPv4-адреса (что вводить в телефоне).
    static QStringList lanAddresses();

signals:
    void log(const QString& message);

private slots:
    void onNewConnection();

private:
    void handleRequest(class QTcpSocket* sock, const QString& method, const QString& path);
    QByteArray route(const QString& method, const QString& path, int& status);

    QTcpServer m_server;
    std::function<Snapshot()> m_provider;
};

} // namespace whnav
