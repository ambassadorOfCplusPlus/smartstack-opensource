// Модель данных ПК-клиента = тот же формат снимка склада (*.whnav.json), что и у
// мобильного приложения/сервера: склад, ячейки, товары, размещения, план, QR-якоря.
// Хранилище = файл снимка (загрузка/сохранение), поэтому «экспорт офлайн» — это просто
// сохранение текущего состояния. Координаты в метрах: X вправо (восток), Y вверх (север).
#pragma once

#include <QString>
#include <QVector>
#include <optional>

namespace whnav {

struct Warehouse {
    QString id;
    QString name;
};

struct Cell {
    QString id;
    QString code;
    QString warehouseId;
    std::optional<double> posXM; // null = ячейка не размечена на карте
    std::optional<double> posYM;
};

struct Product {
    QString id;
    QString sku;
    QString name;
    QString barcode; // пусто = нет
};

struct Placement {
    QString productId;
    QString cellId;
    double quantity = 0;
};

struct LayoutRect {
    double xM = 0, yM = 0;
    double lengthM = 0, widthM = 0;
    double rotationDeg = 0;
    QString kind = "rack"; // rack|wall|door|passage|zone
};

struct Anchor {
    QString warehouseId;
    double xM = 0, yM = 0;
    double headingDeg = 0;
};

// Где лежит товар (агрегат размещений по ячейке) — для ответа навигатору.
struct ProductLocation {
    QString cellId;
    QString code;
    std::optional<double> posXM;
    std::optional<double> posYM;
    double quantity = 0;
};

// Полный снимок одного склада. Единица хранения и обмена.
struct Snapshot {
    Warehouse warehouse;
    QVector<Cell> cells;
    QVector<Product> products;
    QVector<Placement> placements;
    QVector<LayoutRect> layout;
    QVector<Anchor> anchors;

    // Сериализация/разбор в формат *.whnav.json (version:1). parse бросает
    // std::runtime_error на битом/чужом файле.
    QByteArray toJson(bool pretty = true) const;
    static Snapshot fromJson(const QByteArray& bytes);

    // Поиск товара по подстроке (имя/sku/штрихкод), пусто = все.
    QVector<Product> searchProducts(const QString& q) const;
    // Где лежит товар: агрегат по ячейке + координаты с плана.
    QVector<ProductLocation> productLocation(const QString& productId) const;

    // Сборка строки QR-якоря: SSNAV1|warehouseId|xM|yM|headingDeg.
    static QString anchorPayload(const Anchor& a);
};

} // namespace whnav
