// Главное окно ПК-клиента: управление складом (ячейки, товары, размещения, план,
// QR-якоря), запуск встроенного LAN-сервера для телефона и экспорт/импорт офлайн-
// снимка (*.whnav.json). Минимум — никакой БД: состояние редактируется в таблицах,
// собирается в снимок при сохранении/раздаче.
#pragma once

#include <QMainWindow>
#include "Snapshot.hpp"
#include "NavServer.hpp"

class QTableWidget;
class QLineEdit;
class QLabel;
class QPushButton;
class QSpinBox;

namespace whnav {

class MainWindow : public QMainWindow {
    Q_OBJECT
public:
    explicit MainWindow(QWidget* parent = nullptr);

private slots:
    void onOpen();
    void onSave();
    void onToggleServer();
    void onShowAnchorQr();

private:
    void buildUi();
    void loadSnapshot(const Snapshot& s);
    Snapshot collectSnapshot() const; // собрать снимок из таблиц

    QLineEdit* m_warehouseName = nullptr;
    QTableWidget* m_cells = nullptr;
    QTableWidget* m_products = nullptr;
    QTableWidget* m_placements = nullptr;
    QTableWidget* m_layout = nullptr;
    QTableWidget* m_anchors = nullptr;

    QSpinBox* m_port = nullptr;
    QPushButton* m_serverBtn = nullptr;
    QLabel* m_serverStatus = nullptr;

    QString m_warehouseId; // стабильный id склада (генерируется/из файла)
    NavServer m_server;
};

} // namespace whnav
