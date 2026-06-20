#include "Snapshot.hpp"

#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QHash>
#include <stdexcept>

namespace whnav {

namespace {

QJsonValue numOrNull(const std::optional<double>& v) {
    return v ? QJsonValue(*v) : QJsonValue(QJsonValue::Null);
}

std::optional<double> readNumOrNull(const QJsonValue& v) {
    if (v.isNull() || v.isUndefined()) return std::nullopt;
    if (!v.isDouble()) throw std::runtime_error("Ожидалось число или null");
    return v.toDouble();
}

double reqNum(const QJsonObject& o, const QString& k) {
    const QJsonValue v = o.value(k);
    if (!v.isDouble()) throw std::runtime_error(QString("Поле %1 должно быть числом").arg(k).toStdString());
    return v.toDouble();
}

QString reqStr(const QJsonObject& o, const QString& k) {
    const QJsonValue v = o.value(k);
    if (!v.isString()) throw std::runtime_error(QString("Поле %1 должно быть строкой").arg(k).toStdString());
    return v.toString();
}

} // namespace

QByteArray Snapshot::toJson(bool pretty) const {
    QJsonObject root;
    root["version"] = 1;
    root["warehouse"] = QJsonObject{{"id", warehouse.id}, {"name", warehouse.name}};

    QJsonArray jc;
    for (const auto& c : cells) {
        jc.append(QJsonObject{
            {"id", c.id}, {"code", c.code}, {"warehouseId", c.warehouseId},
            {"posXM", numOrNull(c.posXM)}, {"posYM", numOrNull(c.posYM)}});
    }
    root["cells"] = jc;

    QJsonArray jp;
    for (const auto& p : products) {
        jp.append(QJsonObject{
            {"id", p.id}, {"sku", p.sku}, {"name", p.name},
            {"barcode", p.barcode.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(p.barcode)}});
    }
    root["products"] = jp;

    QJsonArray jpl;
    for (const auto& pl : placements) {
        jpl.append(QJsonObject{
            {"productId", pl.productId}, {"cellId", pl.cellId}, {"quantity", pl.quantity}});
    }
    root["placements"] = jpl;

    QJsonArray jl;
    for (const auto& r : layout) {
        jl.append(QJsonObject{
            {"xM", r.xM}, {"yM", r.yM}, {"lengthM", r.lengthM}, {"widthM", r.widthM},
            {"rotationDeg", r.rotationDeg}, {"kind", r.kind}});
    }
    root["layout"] = jl;

    QJsonArray ja;
    for (const auto& a : anchors) {
        ja.append(QJsonObject{
            {"warehouseId", a.warehouseId}, {"xM", a.xM}, {"yM", a.yM}, {"headingDeg", a.headingDeg}});
    }
    root["anchors"] = ja;

    return QJsonDocument(root).toJson(pretty ? QJsonDocument::Indented : QJsonDocument::Compact);
}

Snapshot Snapshot::fromJson(const QByteArray& bytes) {
    QJsonParseError err{};
    const QJsonDocument doc = QJsonDocument::fromJson(bytes, &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject())
        throw std::runtime_error("Файл не является корректным JSON-снимком");
    const QJsonObject root = doc.object();
    if (root.value("version").toInt(-1) != 1)
        throw std::runtime_error("Неподдерживаемая версия снимка");

    Snapshot s;
    const QJsonObject wh = root.value("warehouse").toObject();
    s.warehouse.id = reqStr(wh, "id");
    s.warehouse.name = reqStr(wh, "name");

    for (const QJsonValue v : root.value("cells").toArray()) {
        const QJsonObject o = v.toObject();
        Cell c;
        c.id = reqStr(o, "id");
        c.code = reqStr(o, "code");
        c.warehouseId = reqStr(o, "warehouseId");
        c.posXM = readNumOrNull(o.value("posXM"));
        c.posYM = readNumOrNull(o.value("posYM"));
        s.cells.append(c);
    }
    for (const QJsonValue v : root.value("products").toArray()) {
        const QJsonObject o = v.toObject();
        Product p;
        p.id = reqStr(o, "id");
        p.sku = reqStr(o, "sku");
        p.name = reqStr(o, "name");
        p.barcode = o.value("barcode").isString() ? o.value("barcode").toString() : QString();
        s.products.append(p);
    }
    for (const QJsonValue v : root.value("placements").toArray()) {
        const QJsonObject o = v.toObject();
        Placement pl;
        pl.productId = reqStr(o, "productId");
        pl.cellId = reqStr(o, "cellId");
        pl.quantity = reqNum(o, "quantity");
        s.placements.append(pl);
    }
    for (const QJsonValue v : root.value("layout").toArray()) {
        const QJsonObject o = v.toObject();
        LayoutRect r;
        r.xM = reqNum(o, "xM");
        r.yM = reqNum(o, "yM");
        r.lengthM = reqNum(o, "lengthM");
        r.widthM = reqNum(o, "widthM");
        r.rotationDeg = o.value("rotationDeg").toDouble(0);
        r.kind = o.value("kind").isString() ? o.value("kind").toString() : QString("rack");
        s.layout.append(r);
    }
    for (const QJsonValue v : root.value("anchors").toArray()) {
        const QJsonObject o = v.toObject();
        Anchor a;
        a.warehouseId = reqStr(o, "warehouseId");
        a.xM = reqNum(o, "xM");
        a.yM = reqNum(o, "yM");
        a.headingDeg = reqNum(o, "headingDeg");
        s.anchors.append(a);
    }
    return s;
}

QVector<Product> Snapshot::searchProducts(const QString& q) const {
    const QString s = q.trimmed().toLower();
    if (s.isEmpty()) return products;
    QVector<Product> out;
    for (const auto& p : products) {
        if (p.name.toLower().contains(s) || p.sku.toLower().contains(s) ||
            p.barcode.toLower().contains(s))
            out.append(p);
    }
    return out;
}

QVector<ProductLocation> Snapshot::productLocation(const QString& productId) const {
    QHash<QString, const Cell*> cellById;
    for (const auto& c : cells) cellById.insert(c.id, &c);

    QVector<ProductLocation> out;
    QHash<QString, int> idxByCell; // cellId → индекс в out (агрегация)
    for (const auto& pl : placements) {
        if (pl.productId != productId || pl.quantity <= 0) continue;
        const auto it = cellById.constFind(pl.cellId);
        if (it == cellById.constEnd()) continue;
        const Cell* c = it.value();
        const auto idxIt = idxByCell.constFind(c->id);
        if (idxIt != idxByCell.constEnd()) {
            out[idxIt.value()].quantity += pl.quantity;
        } else {
            idxByCell.insert(c->id, out.size());
            out.append(ProductLocation{c->id, c->code, c->posXM, c->posYM, pl.quantity});
        }
    }
    return out;
}

QString Snapshot::anchorPayload(const Anchor& a) {
    // Формат строго совпадает с core/parseAnchor: SSNAV1|warehouseId|xM|yM|headingDeg.
    return QString("SSNAV1|%1|%2|%3|%4")
        .arg(a.warehouseId)
        .arg(a.xM)
        .arg(a.yM)
        .arg(a.headingDeg);
}

} // namespace whnav
