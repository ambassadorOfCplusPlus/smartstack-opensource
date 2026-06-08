#include "MainWindow.hpp"
#include "ApiClient.hpp"
#include "Crypto.hpp"
#include <QHBoxLayout>
#include <QVBoxLayout>
#include <QListWidget>
#include <QListWidgetItem>
#include <QTextBrowser>
#include <QLineEdit>
#include <QPushButton>
#include <QLabel>
#include <QSplitter>
#include <QScrollBar>
#include <QTimer>
#include <QJsonObject>
#include <QJsonArray>
#include <QJsonDocument>
#include <QInputDialog>
#include <QDialog>
#include <QCheckBox>
#include <QFileDialog>
#include <QMessageBox>
#include <QStandardPaths>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QUrl>
#include <QVariant>
#include <QDateTime>

static QString esc(const QString& s) {
    QString r = s;
    r.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    return r;
}

MainWindow::MainWindow(ApiClient* api, const QString& selfId, const QString& selfName, QWidget* parent)
    : QWidget(parent), m_api(api), m_selfId(selfId), m_selfName(selfName) {
    setWindowTitle("SmartStock Мессенджер — " + selfName);
    resize(900, 600);
    setStyleSheet("QWidget{background:#0b141a;color:#e9edef;} QListWidget,QTextBrowser,QLineEdit{"
                  "background:#111b21;border:1px solid #2a3942;border-radius:6px;} "
                  "QPushButton{background:#202c33;border:0;border-radius:6px;padding:6px 10px;color:#e9edef;}");
    buildUi();
    setupKeys();
    loadConversations();
    m_poll = new QTimer(this);
    connect(m_poll, &QTimer::timeout, this, [this]() {
        loadConversations();
        if (!m_activeConv.isEmpty()) loadMessages(m_activeConv, false);
    });
    m_poll->start(6000);
}

void MainWindow::buildUi() {
    auto* root = new QHBoxLayout(this);
    auto* split = new QSplitter(this);

    auto* left = new QWidget();
    auto* lv = new QVBoxLayout(left);
    auto* newBtn = new QPushButton("＋ Новый диалог");
    auto* groupBtn = new QPushButton("👥 Новая группа");
    m_convList = new QListWidget();
    lv->addWidget(newBtn);
    lv->addWidget(groupBtn);
    lv->addWidget(m_convList, 1);

    auto* right = new QWidget();
    auto* rv = new QVBoxLayout(right);
    m_title = new QLabel("Выберите диалог");
    m_title->setStyleSheet("font-weight:600;padding:4px;");
    m_msgView = new QTextBrowser();
    m_msgView->setOpenLinks(false);
    auto* row = new QHBoxLayout();
    auto* attachBtn = new QPushButton("📎");
    attachBtn->setFixedWidth(40);
    m_input = new QLineEdit();
    m_input->setPlaceholderText("Сообщение");
    auto* sendBtn = new QPushButton("Отправить");
    row->addWidget(attachBtn);
    row->addWidget(m_input, 1);
    row->addWidget(sendBtn);
    rv->addWidget(m_title);
    rv->addWidget(m_msgView, 1);
    rv->addLayout(row);

    split->addWidget(left);
    split->addWidget(right);
    split->setStretchFactor(0, 0);
    split->setStretchFactor(1, 1);
    split->setSizes({ 260, 640 });
    root->addWidget(split);

    connect(newBtn, &QPushButton::clicked, this, &MainWindow::onNewDialog);
    connect(groupBtn, &QPushButton::clicked, this, &MainWindow::onNewGroup);
    connect(sendBtn, &QPushButton::clicked, this, &MainWindow::onSend);
    connect(m_input, &QLineEdit::returnPressed, this, &MainWindow::onSend);
    connect(attachBtn, &QPushButton::clicked, this, &MainWindow::onAttach);
    connect(m_convList, &QListWidget::itemSelectionChanged, this, [this]() {
        auto* it = m_convList->currentItem();
        if (it) openConversation(it->data(Qt::UserRole).toString());
    });
    connect(m_msgView, &QTextBrowser::anchorClicked, this, &MainWindow::onAnchor);
}

void MainWindow::setupKeys() {
    if (!Crypto::available()) return;
    QString dir = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
    QDir().mkpath(dir);
    m_keyFile = dir + "/msg_keys_" + m_selfId + ".bin";
    const QString pub = Crypto::loadOrCreateKeys(m_keyFile);
    if (!pub.isEmpty()) {
        m_api->put("/chat/keys", QJsonObject{ {"publicKey", pub} }, [](bool, const QJsonValue&, int) {});
    }
}

void MainWindow::loadConversations() {
    m_api->get("/chat/conversations", [this](bool ok, const QJsonValue& v, int) {
        if (!ok) return;
        const QJsonArray items = v.toObject().value("items").toArray();
        for (const auto& cv : items) {
            const QJsonObject c = cv.toObject();
            const QString id = c.value("id").toString();
            m_convTitle[id] = c.value("title").toString();
            m_convIsGroup[id] = c.value("isGroup").toBool();
            QStringList members;
            for (const auto& pv : c.value("participants").toArray()) {
                const QJsonObject o = pv.toObject();
                const QString uid = o.value("id").toString();
                members << uid;
                m_pubKeys[uid] = o.value("publicKey").toString();
            }
            m_convMembers[id] = members;
        }
        // сохраним список для отрисовки
        m_convList->setProperty("items", QVariant::fromValue(items));
        renderConversations();
    });
}

void MainWindow::renderConversations() {
    const QJsonArray items = m_convList->property("items").value<QJsonArray>();
    const QString keep = m_activeConv;
    m_convList->blockSignals(true);
    m_convList->clear();
    for (const auto& cv : items) {
        const QJsonObject c = cv.toObject();
        const QString id = c.value("id").toString();
        const int unread = c.value("unread").toInt();
        QString label = c.value("title").toString();
        if (unread > 0) label += QString("  (%1)").arg(unread);
        auto* it = new QListWidgetItem(label);
        it->setData(Qt::UserRole, id);
        m_convList->addItem(it);
        if (id == keep) m_convList->setCurrentItem(it);
    }
    m_convList->blockSignals(false);
}

bool MainWindow::convEncryptable(const QString& convId) const {
    const QStringList members = m_convMembers.value(convId);
    if (members.isEmpty()) return false;
    for (const auto& id : members)
        if (m_pubKeys.value(id).isEmpty()) return false;
    return true;
}

void MainWindow::openConversation(const QString& id) {
    m_activeConv = id;
    const bool enc = convEncryptable(id);
    QString t = m_convTitle.value(id, "Диалог");
    if (m_convIsGroup.value(id))
        t += QString(" · группа (%1)").arg(m_convMembers.value(id).size() + 1);
    t += enc ? "   🔒 зашифровано" : "   ⚠ есть участник без ключа";
    m_title->setText(t);
    loadMessages(id, true);
}

QString MainWindow::encEnvelope(const QString& convId, const QByteArray& payload) {
    if (!Crypto::available()) return QString::fromUtf8(payload);
    QStringList recips = m_convMembers.value(convId);
    recips << m_selfId;
    QJsonObject e;
    bool any = false;
    for (const auto& id : recips) {
        const QString pub = (id == m_selfId) ? Crypto::myPublicKey() : m_pubKeys.value(id);
        if (pub.isEmpty()) continue;
        e[id] = Crypto::encryptFor(pub, payload);
        any = true;
    }
    if (!any) return QString::fromUtf8(payload);
    return QString::fromUtf8(QJsonDocument(QJsonObject{ {"g", 1}, {"e", e} }).toJson(QJsonDocument::Compact));
}

QByteArray MainWindow::decEnvelope(const QString& senderId, const QString& body) {
    if (body.isEmpty()) return {};
    if (!body.startsWith('{')) { // легаси одиночный e2e: / открытый текст
        const QString otherPub = m_pubKeys.value(m_convMembers.value(m_activeConv).value(0));
        return Crypto::decryptFrom(otherPub, body);
    }
    const QJsonObject obj = QJsonDocument::fromJson(body.toUtf8()).object();
    if (!obj.contains("e")) return body.toUtf8(); // не конверт (плейнтекст с '{') — как есть
    const QJsonObject e = obj.value("e").toObject();
    if (!e.contains(m_selfId)) return {};          // конверт без копии для нас
    const QString senderPub = (senderId == m_selfId) ? Crypto::myPublicKey() : m_pubKeys.value(senderId);
    return Crypto::decryptFrom(senderPub, e.value(m_selfId).toString());
}

void MainWindow::loadMessages(const QString& id, bool markRead) {
    m_api->get("/chat/conversations/" + id + "/messages", [this, id, markRead](bool ok, const QJsonValue& v, int) {
        if (!ok || id != m_activeConv) return;
        QJsonArray items = v.toObject().value("items").toArray();
        QString html;
        for (int i = items.size() - 1; i >= 0; --i) {
            const QJsonObject m = items[i].toObject();
            const QString senderId = m.value("senderId").toString();
            const bool mine = senderId == m_selfId;
            const QString rawBody = m.value("body").toString();
            const QByteArray payload = decEnvelope(senderId, rawBody);
            const bool failed = payload.isEmpty() &&
                                (rawBody.startsWith('{') || Crypto::isEncrypted(rawBody));
            const QString att = m.value("attachmentUrl").toString();
            QString body, attHtml;
            if (!att.isEmpty()) {
                const QString k = QString::fromUtf8(att.toUtf8().toBase64(
                    QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));
                QString name = "файл";
                if (!failed) {
                    const QJsonObject fo = QJsonDocument::fromJson(payload).object();
                    if (fo.contains("k")) {
                        name = fo.value("name").toString("файл");
                        m_fileKeyB64[k] = fo.value("k").toString();
                        m_fileName[k] = name;
                    } else {
                        name = QString::fromUtf8(payload);
                        const QString pfx = QString::fromUtf8("📎 ");
                        if (name.startsWith(pfx)) name = name.mid(pfx.size());
                    }
                }
                body = failed ? "🔒 [не удалось расшифровать]" : ("📎 " + esc(name));
                // Ссылку даём только если смогли расшифровать (есть ключ файла) —
                // иначе по клику сохранился бы зашифрованный мусор.
                if (!failed)
                    attHtml = QString(" <a style='color:#8fd3ff' href='dl:%1'>Скачать</a>").arg(k);
            } else {
                body = failed ? "🔒 [не удалось расшифровать]" : esc(QString::fromUtf8(payload));
            }
            const QString align = mine ? "right" : "left";
            const QString color = mine ? "#005c4b" : "#202c33";
            const QString tm = QDateTime::fromString(m.value("createdAt").toString(), Qt::ISODateWithMs)
                                   .toLocalTime().toString("dd.MM HH:mm");
            html += QString("<div style='text-align:%1;margin:4px 0;'><span style='background:%2;"
                            "padding:6px 10px;border-radius:8px;display:inline-block;'>%3%4"
                            "<span style='color:#8696a0;font-size:11px;'> %5</span></span></div>")
                        .arg(align, color, body, attHtml, tm);
        }
        m_msgView->setHtml(html);
        m_msgView->verticalScrollBar()->setValue(m_msgView->verticalScrollBar()->maximum());
        if (markRead)
            m_api->post("/chat/conversations/" + id + "/read", {}, [this](bool, const QJsonValue&, int) {
                loadConversations();
            });
    });
}

void MainWindow::onSend() {
    const QString text = m_input->text().trimmed();
    if (text.isEmpty() || m_activeConv.isEmpty()) return;
    if (Crypto::available() && !convEncryptable(m_activeConv)) {
        if (QMessageBox::question(this, "Без шифрования",
                "У части участников ещё нет ключа (не заходили).\n"
                "Они не смогут прочитать сообщение. Отправить?") != QMessageBox::Yes)
            return;
    }
    m_input->clear();
    const QString body = encEnvelope(m_activeConv, text.toUtf8());
    m_api->post("/chat/conversations/" + m_activeConv + "/messages",
                QJsonObject{ {"body", body} }, [this](bool ok, const QJsonValue& v, int) {
                    if (!ok) { QMessageBox::warning(this, "Чат", v.toObject().value("message").toString("Ошибка")); return; }
                    loadMessages(m_activeConv, false);
                    loadConversations();
                });
}

void MainWindow::onAttach() {
    if (m_activeConv.isEmpty()) return;
    const QString path = QFileDialog::getOpenFileName(this, "Файл для отправки");
    if (path.isEmpty()) return;
    if (Crypto::available() && !convEncryptable(m_activeConv)) {
        if (QMessageBox::question(this, "Без шифрования",
                "У части участников ещё нет ключа. Они не смогут открыть файл. Отправить?")
            != QMessageBox::Yes)
            return;
    }
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) return;
    const QByteArray bytes = f.readAll();
    f.close();
    // E2E файла (гибрид): шифруем содержимое случайным ключом K один раз; K кладём
    // в конверт сообщения каждому участнику.
    QString keyB64;
    const QByteArray blob = Crypto::secretboxEnc(bytes, keyB64);
    QString tmp = QDir::temp().filePath("ssm_up_" + QFileInfo(path).fileName());
    QFile tf(tmp);
    if (tf.open(QIODevice::WriteOnly)) { tf.write(blob); tf.close(); }
    const QString convId = m_activeConv;
    const QString name = QFileInfo(path).fileName();
    m_api->uploadFile("/chat/conversations/" + convId + "/attachments", tmp,
                      [this, convId, name, keyB64](bool ok, const QJsonValue& v, int) {
        QFile::remove(QDir::temp().filePath("ssm_up_" + name));
        if (!ok) { QMessageBox::warning(this, "Файл", v.toObject().value("message").toString("Не удалось загрузить")); return; }
        const QString key = v.toObject().value("key").toString();
        const QJsonObject payload{ {"name", name}, {"k", keyB64} };
        const QString body = encEnvelope(convId,
            QJsonDocument(payload).toJson(QJsonDocument::Compact));
        m_api->post("/chat/conversations/" + convId + "/messages",
                    QJsonObject{ {"body", body}, {"attachmentUrl", key} },
                    [this, convId](bool, const QJsonValue&, int) { loadMessages(convId, false); });
    });
}

void MainWindow::onAnchor(const QUrl& link) {
    const QString s = link.toString();
    if (!s.startsWith("dl:")) return;
    const QString key64 = s.mid(3);
    const QString fileKey = m_fileKeyB64.value(key64);
    const QString hintName = m_fileName.value(key64);
    m_api->downloadBin("/chat/attachments/download?key64=" + key64,
                       [this, fileKey, hintName](bool ok, const QByteArray& data, const QString& filename) {
        if (!ok) { QMessageBox::warning(this, "Файл", "Не удалось скачать"); return; }
        QByteArray out;
        if (!fileKey.isEmpty()) {                     // новый формат: гибрид (secretbox по K)
            out = Crypto::secretboxDec(data, fileKey);
            if (out.isEmpty()) { QMessageBox::warning(this, "Файл", "Не удалось расшифровать файл"); return; }
        } else {                                      // легаси: e2e: блоб 1-на-1 или открытый
            const QByteArray plain = Crypto::decryptFrom(
                m_pubKeys.value(m_convMembers.value(m_activeConv).value(0)), QString::fromUtf8(data));
            out = plain.isEmpty() ? data : plain;
        }
        const QString def = !hintName.isEmpty() ? hintName : (filename.isEmpty() ? "file" : filename);
        const QString save = QFileDialog::getSaveFileName(this, "Сохранить", def);
        if (save.isEmpty()) return;
        QFile o(save);
        if (o.open(QIODevice::WriteOnly)) { o.write(out); o.close(); QMessageBox::information(this, "Файл", "Сохранено"); }
    });
}

void MainWindow::onNewDialog() {
    m_api->get("/chat/contacts?q=", [this](bool ok, const QJsonValue& v, int) {
        if (!ok) return;
        const QJsonArray items = v.toObject().value("items").toArray();
        QStringList names;
        QList<QString> ids;
        for (const auto& uv : items) {
            const QJsonObject u = uv.toObject();
            names << QString("%1 (%2)").arg(u.value("name").toString(), u.value("messengerId").toString());
            ids << u.value("id").toString();
            m_pubKeys[u.value("id").toString()] = u.value("publicKey").toString();
        }
        if (names.isEmpty()) { QMessageBox::information(this, "Новый диалог", "Нет доступных собеседников"); return; }
        bool okSel = false;
        const QString chosen = QInputDialog::getItem(this, "Новый диалог", "Собеседник:", names, 0, false, &okSel);
        if (!okSel) return;
        const QString uid = ids[names.indexOf(chosen)];
        m_api->post("/chat/conversations", QJsonObject{ {"participantId", uid} },
                    [this](bool ok2, const QJsonValue& v2, int) {
            if (!ok2) return;
            const QString id = v2.toObject().value("id").toString();
            loadConversations();
            openConversation(id);
        });
    });
}

void MainWindow::onNewGroup() {
    m_api->get("/chat/contacts?q=", [this](bool ok, const QJsonValue& v, int) {
        if (!ok) return;
        const QJsonArray items = v.toObject().value("items").toArray();
        if (items.isEmpty()) { QMessageBox::information(this, "Группа", "Нет доступных участников"); return; }
        QDialog dlg(this);
        dlg.setWindowTitle("Новая группа");
        auto* lay = new QVBoxLayout(&dlg);
        auto* nameEdit = new QLineEdit(&dlg);
        nameEdit->setPlaceholderText("Название группы");
        lay->addWidget(nameEdit);
        QList<QCheckBox*> boxes;
        QStringList ids;
        for (const auto& uv : items) {
            const QJsonObject u = uv.toObject();
            const QString uid = u.value("id").toString();
            m_pubKeys[uid] = u.value("publicKey").toString();
            auto* cb = new QCheckBox(QString("%1 (%2)").arg(u.value("name").toString(),
                                                            u.value("messengerId").toString()), &dlg);
            lay->addWidget(cb);
            boxes << cb;
            ids << uid;
        }
        auto* okBtn = new QPushButton("Создать", &dlg);
        lay->addWidget(okBtn);
        connect(okBtn, &QPushButton::clicked, &dlg, &QDialog::accept);
        if (dlg.exec() != QDialog::Accepted) return;
        const QString title = nameEdit->text().trimmed();
        if (title.isEmpty()) { QMessageBox::warning(this, "Группа", "Введите название группы"); return; }
        QJsonArray pids;
        for (int i = 0; i < boxes.size(); ++i)
            if (boxes[i]->isChecked()) pids.append(ids[i]);
        if (pids.isEmpty()) { QMessageBox::warning(this, "Группа", "Выберите участников"); return; }
        m_api->post("/chat/groups", QJsonObject{ {"title", title}, {"participantIds", pids} },
                    [this](bool ok2, const QJsonValue& v2, int) {
            if (!ok2) { QMessageBox::warning(this, "Группа", v2.toObject().value("message").toString("Ошибка")); return; }
            const QString id = v2.toObject().value("id").toString();
            loadConversations();
            openConversation(id);
        });
    });
}
