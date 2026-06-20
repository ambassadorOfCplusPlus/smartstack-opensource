#include "MainWindow.hpp"
#include "QrImage.hpp"

#include <QtWidgets>
#include <QUuid>
#include <functional>

namespace whnav {

namespace {

// Утилиты для таблиц.
QTableWidget* makeTable(const QStringList& headers) {
    auto* t = new QTableWidget(0, headers.size());
    t->setHorizontalHeaderLabels(headers);
    t->horizontalHeader()->setStretchLastSection(true);
    t->setSelectionBehavior(QAbstractItemView::SelectRows);
    return t;
}

void addRow(QTableWidget* t, const QStringList& values) {
    const int r = t->rowCount();
    t->insertRow(r);
    for (int c = 0; c < values.size(); ++c)
        t->setItem(r, c, new QTableWidgetItem(values.value(c)));
}

QString cell(const QTableWidget* t, int r, int c) {
    const QTableWidgetItem* it = t->item(r, c);
    return it ? it->text().trimmed() : QString();
}

// ID склада ОБЯЗАН быть полным UUID: мобильный parseAnchor валидирует второе поле
// QR-якоря по UUID-регэкспу и отвергает любой иной формат (иначе скан не привязывает
// позицию). Полный canonical UUID без фигурных скобок.
QString newWarehouseId() {
    return QUuid::createUuid().toString(QUuid::WithoutBraces);
}

// Кнопки добавить/удалить строку под таблицей.
QWidget* tableWithButtons(QTableWidget* t, const std::function<void()>& onAdd) {
    auto* w = new QWidget;
    auto* lay = new QVBoxLayout(w);
    lay->setContentsMargins(0, 0, 0, 0);
    lay->addWidget(t);
    auto* row = new QHBoxLayout;
    auto* add = new QPushButton(QObject::tr("Добавить"));
    auto* del = new QPushButton(QObject::tr("Удалить строку"));
    QObject::connect(add, &QPushButton::clicked, t, [onAdd]() { onAdd(); });
    QObject::connect(del, &QPushButton::clicked, t, [t]() {
        const int r = t->currentRow();
        if (r >= 0) t->removeRow(r);
    });
    row->addWidget(add);
    row->addWidget(del);
    row->addStretch();
    lay->addLayout(row);
    return w;
}

} // namespace

MainWindow::MainWindow(QWidget* parent) : QMainWindow(parent) {
    m_warehouseId = newWarehouseId();
    buildUi();
    // Сервер всегда отдаёт АКТУАЛЬНЫЙ снимок из таблиц.
    m_server.setProvider([this]() { return collectSnapshot(); });
    connect(&m_server, &NavServer::log, this, [this](const QString& m) {
        statusBar()->showMessage(m, 5000);
    });
}

void MainWindow::buildUi() {
    setWindowTitle(tr("Навигатор по складу — ПК-клиент"));
    resize(900, 600);

    auto* central = new QWidget;
    auto* root = new QVBoxLayout(central);

    // Шапка: название склада.
    auto* head = new QHBoxLayout;
    head->addWidget(new QLabel(tr("Склад:")));
    m_warehouseName = new QLineEdit(tr("Основной склад"));
    head->addWidget(m_warehouseName, 1);
    root->addLayout(head);

    // Вкладки сущностей.
    auto* tabs = new QTabWidget;
    m_cells = makeTable({tr("Код"), tr("X, м"), tr("Y, м")});
    m_products = makeTable({tr("Артикул (sku)"), tr("Название"), tr("Штрихкод")});
    m_placements = makeTable({tr("Товар (sku)"), tr("Ячейка (код)"), tr("Кол-во")});
    m_layout = makeTable({tr("X"), tr("Y"), tr("Длина"), tr("Ширина"), tr("Поворот°"), tr("Тип")});
    m_anchors = makeTable({tr("X, м"), tr("Y, м"), tr("Курс°")});

    tabs->addTab(tableWithButtons(m_cells, [this]() { addRow(m_cells, {"A-01", "0", "0"}); }),
                 tr("Ячейки"));
    tabs->addTab(tableWithButtons(m_products, [this]() { addRow(m_products, {"SKU", "Товар", ""}); }),
                 tr("Товары"));
    tabs->addTab(tableWithButtons(m_placements, [this]() { addRow(m_placements, {"SKU", "A-01", "1"}); }),
                 tr("Размещения"));
    tabs->addTab(tableWithButtons(m_layout, [this]() { addRow(m_layout, {"0", "0", "1", "1", "0", "rack"}); }),
                 tr("План"));

    // Якоря + кнопка показать QR-строку.
    auto* anchorsTab = new QWidget;
    auto* al = new QVBoxLayout(anchorsTab);
    al->addWidget(m_anchors);
    auto* arow = new QHBoxLayout;
    auto* aAdd = new QPushButton(tr("Добавить"));
    auto* aDel = new QPushButton(tr("Удалить строку"));
    auto* aQr = new QPushButton(tr("Показать QR-строку"));
    connect(aAdd, &QPushButton::clicked, this, [this]() { addRow(m_anchors, {"0", "0", "0"}); });
    connect(aDel, &QPushButton::clicked, this, [this]() {
        const int r = m_anchors->currentRow();
        if (r >= 0) m_anchors->removeRow(r);
    });
    connect(aQr, &QPushButton::clicked, this, &MainWindow::onShowAnchorQr);
    arow->addWidget(aAdd);
    arow->addWidget(aDel);
    arow->addWidget(aQr);
    arow->addStretch();
    al->addLayout(arow);
    tabs->addTab(anchorsTab, tr("QR-якоря"));

    root->addWidget(tabs, 1);

    // Панель сервера.
    auto* srv = new QHBoxLayout;
    srv->addWidget(new QLabel(tr("Порт:")));
    m_port = new QSpinBox;
    m_port->setRange(1, 65535);
    m_port->setValue(8088);
    srv->addWidget(m_port);
    m_serverBtn = new QPushButton(tr("Запустить LAN-сервер"));
    connect(m_serverBtn, &QPushButton::clicked, this, &MainWindow::onToggleServer);
    srv->addWidget(m_serverBtn);
    m_serverStatus = new QLabel(tr("сервер остановлен"));
    srv->addWidget(m_serverStatus, 1);
    root->addLayout(srv);

    setCentralWidget(central);

    // Меню «Файл».
    auto* file = menuBar()->addMenu(tr("Файл"));
    file->addAction(tr("Открыть снимок…"), this, &MainWindow::onOpen);
    file->addAction(tr("Сохранить снимок (экспорт офлайн)…"), this, &MainWindow::onSave);
    file->addSeparator();
    file->addAction(tr("Выход"), this, &QWidget::close);

    // Демо-строки, чтобы окно было не пустым.
    addRow(m_cells, {"A-01", "2", "1"});
    addRow(m_products, {"GAYKA-M6", "Гайка М6", "4600000000017"});
    addRow(m_placements, {"GAYKA-M6", "A-01", "120"});
    addRow(m_anchors, {"0", "0", "0"});
}

Snapshot MainWindow::collectSnapshot() const {
    Snapshot s;
    s.warehouse.id = m_warehouseId;
    s.warehouse.name = m_warehouseName->text().trimmed();

    // Ячейки: code, X, Y. id генерируем стабильно по коду (чтобы размещения нашли ячейку).
    QHash<QString, QString> cellIdByCode;
    for (int r = 0; r < m_cells->rowCount(); ++r) {
        const QString code = cell(m_cells, r, 0);
        if (code.isEmpty()) continue;
        Cell c;
        c.code = code;
        c.id = "cell_" + code;
        c.warehouseId = m_warehouseId;
        const QString xs = cell(m_cells, r, 1);
        const QString ys = cell(m_cells, r, 2);
        bool okx = false, oky = false;
        const double x = xs.toDouble(&okx);
        const double y = ys.toDouble(&oky);
        if (okx && !xs.isEmpty()) c.posXM = x;
        if (oky && !ys.isEmpty()) c.posYM = y;
        cellIdByCode.insert(code, c.id);
        s.cells.append(c);
    }

    // Товары: sku, name, barcode. id = "prod_"+sku.
    QHash<QString, QString> prodIdBySku;
    for (int r = 0; r < m_products->rowCount(); ++r) {
        const QString sku = cell(m_products, r, 0);
        if (sku.isEmpty()) continue;
        Product p;
        p.sku = sku;
        p.id = "prod_" + sku;
        p.name = cell(m_products, r, 1);
        p.barcode = cell(m_products, r, 2);
        prodIdBySku.insert(sku, p.id);
        s.products.append(p);
    }

    // Размещения: sku → productId, code → cellId.
    for (int r = 0; r < m_placements->rowCount(); ++r) {
        const QString sku = cell(m_placements, r, 0);
        const QString code = cell(m_placements, r, 1);
        const auto pit = prodIdBySku.constFind(sku);
        const auto cit = cellIdByCode.constFind(code);
        if (pit == prodIdBySku.constEnd() || cit == cellIdByCode.constEnd()) continue;
        Placement pl;
        pl.productId = pit.value();
        pl.cellId = cit.value();
        pl.quantity = cell(m_placements, r, 2).toDouble();
        s.placements.append(pl);
    }

    // План.
    for (int r = 0; r < m_layout->rowCount(); ++r) {
        LayoutRect rc;
        rc.xM = cell(m_layout, r, 0).toDouble();
        rc.yM = cell(m_layout, r, 1).toDouble();
        rc.lengthM = cell(m_layout, r, 2).toDouble();
        rc.widthM = cell(m_layout, r, 3).toDouble();
        rc.rotationDeg = cell(m_layout, r, 4).toDouble();
        const QString kind = cell(m_layout, r, 5);
        rc.kind = kind.isEmpty() ? QStringLiteral("rack") : kind;
        s.layout.append(rc);
    }

    // Якоря (warehouseId = текущий склад).
    for (int r = 0; r < m_anchors->rowCount(); ++r) {
        Anchor a;
        a.warehouseId = m_warehouseId;
        a.xM = cell(m_anchors, r, 0).toDouble();
        a.yM = cell(m_anchors, r, 1).toDouble();
        a.headingDeg = cell(m_anchors, r, 2).toDouble();
        s.anchors.append(a);
    }
    return s;
}

void MainWindow::loadSnapshot(const Snapshot& s) {
    m_warehouseId = s.warehouse.id.isEmpty() ? newWarehouseId() : s.warehouse.id;
    m_warehouseName->setText(s.warehouse.name);

    QHash<QString, QString> codeByCellId, skuByProdId;
    m_cells->setRowCount(0);
    for (const auto& c : s.cells) {
        addRow(m_cells, {c.code,
                         c.posXM ? QString::number(*c.posXM) : QString(),
                         c.posYM ? QString::number(*c.posYM) : QString()});
        codeByCellId.insert(c.id, c.code);
    }
    m_products->setRowCount(0);
    for (const auto& p : s.products) {
        addRow(m_products, {p.sku, p.name, p.barcode});
        skuByProdId.insert(p.id, p.sku);
    }
    m_placements->setRowCount(0);
    for (const auto& pl : s.placements) {
        addRow(m_placements, {skuByProdId.value(pl.productId, pl.productId),
                              codeByCellId.value(pl.cellId, pl.cellId),
                              QString::number(pl.quantity)});
    }
    m_layout->setRowCount(0);
    for (const auto& r : s.layout) {
        addRow(m_layout, {QString::number(r.xM), QString::number(r.yM),
                          QString::number(r.lengthM), QString::number(r.widthM),
                          QString::number(r.rotationDeg), r.kind});
    }
    m_anchors->setRowCount(0);
    for (const auto& a : s.anchors) {
        addRow(m_anchors, {QString::number(a.xM), QString::number(a.yM),
                           QString::number(a.headingDeg)});
    }
}

void MainWindow::onOpen() {
    const QString path = QFileDialog::getOpenFileName(
        this, tr("Открыть снимок склада"), {}, tr("Снимок склада (*.whnav.json);;Все файлы (*)"));
    if (path.isEmpty()) return;
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) {
        QMessageBox::warning(this, tr("Ошибка"), tr("Не удалось открыть файл"));
        return;
    }
    try {
        loadSnapshot(Snapshot::fromJson(f.readAll()));
    } catch (const std::exception& e) {
        QMessageBox::warning(this, tr("Ошибка снимка"), QString::fromUtf8(e.what()));
    }
}

void MainWindow::onSave() {
    QString path = QFileDialog::getSaveFileName(
        this, tr("Сохранить снимок склада"), "warehouse.whnav.json",
        tr("Снимок склада (*.whnav.json)"));
    if (path.isEmpty()) return;
    if (!path.endsWith(".whnav.json")) path += ".whnav.json";
    QFile f(path);
    if (!f.open(QIODevice::WriteOnly)) {
        QMessageBox::warning(this, tr("Ошибка"), tr("Не удалось сохранить файл"));
        return;
    }
    f.write(collectSnapshot().toJson(true));
    statusBar()->showMessage(tr("Снимок сохранён: %1").arg(path), 5000);
}

void MainWindow::onToggleServer() {
    if (m_server.isRunning()) {
        m_server.stop();
        m_serverBtn->setText(tr("Запустить LAN-сервер"));
        m_serverStatus->setText(tr("сервер остановлен"));
        return;
    }
    if (!m_server.start(static_cast<quint16>(m_port->value()))) {
        QMessageBox::warning(this, tr("Сервер"), tr("Не удалось запустить сервер на этом порту"));
        return;
    }
    m_serverBtn->setText(tr("Остановить сервер"));
    QStringList urls;
    for (const QString& ip : NavServer::lanAddresses())
        urls << QString("http://%1:%2").arg(ip).arg(m_server.port());
    m_serverStatus->setText(tr("в телефоне: %1").arg(urls.join("  /  ")));
}

void MainWindow::onShowAnchorQr() {
    const int r = m_anchors->currentRow();
    if (r < 0) {
        QMessageBox::information(this, tr("QR-якорь"), tr("Выберите якорь в таблице"));
        return;
    }
    Anchor a;
    a.warehouseId = m_warehouseId;
    a.xM = cell(m_anchors, r, 0).toDouble();
    a.yM = cell(m_anchors, r, 1).toDouble();
    a.headingDeg = cell(m_anchors, r, 2).toDouble();
    const QString payload = Snapshot::anchorPayload(a);

    QImage img;
    try {
        img = qrToImage(payload, 8, 4);
    } catch (const std::exception& e) {
        QMessageBox::warning(this, tr("QR-якорь"), QString::fromUtf8(e.what()));
        return;
    }

    // Диалог с картинкой QR, строкой-содержимым и сохранением в PNG (для печати/наклейки).
    QDialog dlg(this);
    dlg.setWindowTitle(tr("QR-якорь"));
    auto* lay = new QVBoxLayout(&dlg);

    auto* pic = new QLabel;
    pic->setPixmap(QPixmap::fromImage(img));
    pic->setAlignment(Qt::AlignCenter);
    lay->addWidget(pic);

    auto* hint = new QLabel(tr("Наклейте в точке X=%1, Y=%2 (курс %3°).\n%4")
                                .arg(a.xM).arg(a.yM).arg(a.headingDeg).arg(payload));
    hint->setTextInteractionFlags(Qt::TextSelectableByMouse);
    hint->setWordWrap(true);
    hint->setAlignment(Qt::AlignCenter);
    lay->addWidget(hint);

    auto* btns = new QHBoxLayout;
    auto* save = new QPushButton(tr("Сохранить PNG…"));
    auto* close = new QPushButton(tr("Закрыть"));
    connect(save, &QPushButton::clicked, &dlg, [this, &img, a]() {
        QString path = QFileDialog::getSaveFileName(
            this, tr("Сохранить QR-якорь"),
            QStringLiteral("anchor_%1_%2.png").arg(a.xM).arg(a.yM), tr("PNG (*.png)"));
        if (!path.isEmpty()) img.save(path, "PNG");
    });
    connect(close, &QPushButton::clicked, &dlg, &QDialog::accept);
    btns->addWidget(save);
    btns->addStretch();
    btns->addWidget(close);
    lay->addLayout(btns);

    dlg.exec();
}

} // namespace whnav
