#pragma once
#include <QWidget>
#include <QHash>
#include <QString>
#include <QStringList>
class ApiClient;
class QListWidget;
class QTextBrowser;
class QLineEdit;
class QLabel;
class QTimer;
class QUrl;

// Главное окно мессенджера: диалоги слева, переписка справа. E2E: шифруем тела
// и файлы публичным ключом собеседника (общий ключ диалога), приватный — локально.
class MainWindow : public QWidget {
    Q_OBJECT
public:
    MainWindow(ApiClient* api, const QString& selfId, const QString& selfName,
               QWidget* parent = nullptr);

private:
    void buildUi();
    void setupKeys();             // E2E: загрузить/создать пару, опубликовать pubkey
    void loadConversations();
    void renderConversations();
    void openConversation(const QString& id);
    void loadMessages(const QString& id, bool markRead);
    void onSend();
    void onAttach();
    void onNewDialog();
    void onNewGroup();
    void onAnchor(const QUrl& link);

    // E2E-конверт: payload шифруется каждому участнику (включая себя).
    QString encEnvelope(const QString& convId, const QByteArray& payload);
    QByteArray decEnvelope(const QString& senderId, const QString& body);
    bool convEncryptable(const QString& convId) const;

    // Приватность (sealed-sender / «вариант 1»):
    // padding длины сообщения; trial-decrypt автора (senderId с сервера пуст);
    // отпечаток ключа (safety number) для защиты от подмены ключа (MITM).
    QString padPayload(const QString& s) const;
    QString unpadPayload(const QString& s) const;
    // Расшифровать + определить отправителя. Если senderId пуст (sealed) —
    // перебираем ключи участников: автор тот, чьим ключом расшифровалась наша копия.
    QByteArray decMessage(const QString& senderId, const QString& body, QString& outSender);
    QString keyFingerprint(const QString& pubB64) const;
    void showSafety();
    void ensurePostToken(const QString& convId);  // получить секрет постинга диалога

    ApiClient* m_api;
    QString m_selfId, m_selfName;
    QString m_activeConv;
    QString m_keyFile;
    QHash<QString, QString> m_pubKeys;          // userId → publicKey
    QHash<QString, QStringList> m_convMembers;  // convId → id участников (без себя)
    QHash<QString, bool> m_convIsGroup;
    QHash<QString, QString> m_convTitle;
    QHash<QString, QString> m_fileKeyB64;       // key64 вложения → ключ файла
    QHash<QString, QString> m_fileName;         // key64 вложения → имя
    QHash<QString, QString> m_postToken;        // convId → секрет постинга (sealed-sender)

    QListWidget*  m_convList = nullptr;
    QTextBrowser* m_msgView = nullptr;
    QLineEdit*    m_input = nullptr;
    QLabel*       m_title = nullptr;
    QTimer*       m_poll = nullptr;
};
