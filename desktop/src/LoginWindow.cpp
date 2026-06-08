#include "LoginWindow.hpp"
#include "ApiClient.hpp"
#include <QVBoxLayout>
#include <QFormLayout>
#include <QLineEdit>
#include <QLabel>
#include <QPushButton>
#include <QTabWidget>
#include <QJsonObject>
#include <QSettings>
#include <QCoreApplication>
#include <QFile>

LoginWindow::LoginWindow(ApiClient* api, QWidget* parent) : QWidget(parent), m_api(api) {
    setWindowTitle("SmartStock Мессенджер — вход");
    setMinimumWidth(360);
    QSettings st;
    // Склейка: установщик может вшить адрес сервера в server.txt рядом с exe —
    // тогда сотруднику не нужно его вводить. Приоритет: ранее сохранённый →
    // вшитый server.txt → localhost (dev).
    QString savedServer = st.value("server", "").toString();
    if (savedServer.isEmpty()) {
        QFile baked(QCoreApplication::applicationDirPath() + "/server.txt");
        if (baked.exists() && baked.open(QIODevice::ReadOnly))
            savedServer = QString::fromUtf8(baked.readAll()).trimmed();
    }
    if (savedServer.isEmpty()) savedServer = "http://localhost";

    auto* root = new QVBoxLayout(this);
    auto* title = new QLabel("SmartStock Мессенджер");
    title->setStyleSheet("font-size:18px;font-weight:600;");
    root->addWidget(title);
    auto* sub = new QLabel("Вход по ключу, который выдал администратор.");
    sub->setStyleSheet("color:#8696a0;");
    root->addWidget(sub);

    m_server = new QLineEdit(savedServer);
    m_server->setPlaceholderText("https://erp.компания.ru или http://203.0.113.5");
    auto* sf = new QFormLayout();
    sf->addRow("Адрес сервера:", m_server);
    root->addLayout(sf);
    auto* srvHint = new QLabel(
        "Адрес сервера вашей компании (его даёт администратор):\n"
        "• домен → https://erp.компания.ru\n"
        "• IP → http://203.0.113.5 (или https://… с сертификатом)");
    srvHint->setStyleSheet("color:#8696a0;font-size:11px;");
    srvHint->setWordWrap(true);
    root->addWidget(srvHint);

    auto* tabs = new QTabWidget(this);
    // Вход
    auto* login = new QWidget();
    auto* lf = new QFormLayout(login);
    m_liKey = new QLineEdit();  m_liKey->setPlaceholderText("Ключ (напр. ABCD1234)");
    m_liPass = new QLineEdit(); m_liPass->setEchoMode(QLineEdit::Password);
    lf->addRow("Ключ:", m_liKey);
    lf->addRow("Пароль:", m_liPass);
    auto* loginBtn = new QPushButton("Войти");
    lf->addRow(loginBtn);
    tabs->addTab(login, "Вход");
    // Регистрация
    auto* reg = new QWidget();
    auto* rf = new QFormLayout(reg);
    m_rgKey = new QLineEdit();   m_rgKey->setPlaceholderText("Ключ от администратора");
    m_rgName = new QLineEdit();  m_rgName->setPlaceholderText("Ваше имя");
    m_rgPass = new QLineEdit();  m_rgPass->setEchoMode(QLineEdit::Password);
    m_rgEmail = new QLineEdit(); m_rgEmail->setPlaceholderText("E-mail для восстановления (необяз.)");
    rf->addRow("Ключ:", m_rgKey);
    rf->addRow("Имя:", m_rgName);
    rf->addRow("Пароль:", m_rgPass);
    rf->addRow("E-mail:", m_rgEmail);
    auto* regBtn = new QPushButton("Зарегистрироваться");
    rf->addRow(regBtn);
    tabs->addTab(reg, "Регистрация");
    root->addWidget(tabs);

    m_err = new QLabel();
    m_err->setStyleSheet("color:#ff6b6b;");
    m_err->setWordWrap(true);
    root->addWidget(m_err);

    connect(loginBtn, &QPushButton::clicked, this, &LoginWindow::doLogin);
    connect(regBtn, &QPushButton::clicked, this, &LoginWindow::doRegister);
}

void LoginWindow::setError(const QString& s) { m_err->setText(s); }

void LoginWindow::doLogin() {
    setError("");
    const QString srv = m_server->text().trimmed();
    QSettings().setValue("server", srv);
    m_api->setServer(srv);
    QJsonObject body{ {"messengerId", m_liKey->text().trimmed()}, {"password", m_liPass->text()} };
    m_api->post("/login", body, [this](bool ok, const QJsonValue& v, int) {
        if (!ok) { setError(v.toObject().value("message").toString("Не удалось войти")); return; }
        const QJsonObject o = v.toObject();
        m_api->setToken(o.value("accessToken").toString());
        const QJsonObject u = o.value("user").toObject();
        emit loggedIn(u.value("id").toString(), u.value("displayName").toString());
    });
}

void LoginWindow::doRegister() {
    setError("");
    const QString srv = m_server->text().trimmed();
    QSettings().setValue("server", srv);
    m_api->setServer(srv);
    QJsonObject body{
        {"messengerId", m_rgKey->text().trimmed()},
        {"displayName", m_rgName->text().trimmed()},
        {"password", m_rgPass->text()},
    };
    const QString email = m_rgEmail->text().trimmed();
    if (!email.isEmpty()) body.insert("recoveryEmail", email);
    m_api->post("/register", body, [this](bool ok, const QJsonValue& v, int) {
        if (!ok) { setError(v.toObject().value("message").toString("Не удалось зарегистрироваться")); return; }
        // Автовход.
        m_liKey->setText(m_rgKey->text());
        m_liPass->setText(m_rgPass->text());
        doLogin();
    });
}
