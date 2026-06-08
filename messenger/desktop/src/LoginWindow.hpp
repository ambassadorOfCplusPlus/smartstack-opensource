#pragma once
#include <QWidget>
class ApiClient;
class QLineEdit;
class QLabel;
class QTabWidget;

// Окно входа/регистрации по ключу. Использует общий ApiClient (его настраивает
// при успехе). По входу эмитит loggedIn(selfId, selfName).
class LoginWindow : public QWidget {
    Q_OBJECT
public:
    explicit LoginWindow(ApiClient* api, QWidget* parent = nullptr);

signals:
    void loggedIn(const QString& selfId, const QString& selfName);

private:
    void doLogin();
    void doRegister();
    void setError(const QString& s);

    ApiClient* m_api;
    QLineEdit* m_server;
    QLineEdit* m_liKey;
    QLineEdit* m_liPass;
    QLineEdit* m_rgKey;
    QLineEdit* m_rgName;
    QLineEdit* m_rgPass;
    QLineEdit* m_rgEmail;
    QLabel*    m_err;
};
