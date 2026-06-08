#include "inventory/WriteoffEngine.hpp"
#include "core/data/DatabaseManager.hpp"
#include "core/utils/RAIIWrappers.hpp"
#include "core/utils/AppSettings.hpp"
#include "core/ActionLogger.hpp"

#include <QSettings>
#include <QUuid>
#include <QJsonObject>
#include <sqlite3.h>
#include <algorithm>
#include <numeric>
#include <string>
#include <vector>

namespace smartstock::inventory {

using core::data::DatabaseManager;
using core::data::Transaction;

namespace {
constexpr double kEps = 1e-6;

std::shared_ptr<sqlite3> connection() {
    return DatabaseManager::getInstance().getConnection();
}
} // namespace

WriteoffEngine::WriteoffEngine(QObject* parent) : QObject(parent) {}

// ─────────────────────────────────────────────────────────────────────────────
// Подбор партий (без записи в БД)
// ─────────────────────────────────────────────────────────────────────────────
WriteoffResult WriteoffEngine::computePlan(sqlite3* db, const QString& productId, double quantity,
                                           WriteoffMethod method, int warehouseId) {
    const std::string productIdStd = productId.toStdString();
    WriteoffResult r;

    struct Row { qint64 id; double avail; double cost; };
    std::vector<Row> rows;
    double totalAvail = 0.0;

    std::string sql =
        "SELECT id, (quantity - reserved) AS avail, cost_price FROM batches "
        "WHERE product_id = ?1 AND status = 'active' "
        "AND (quantity - reserved) > 1e-6 "
        "AND (?2 = 0 OR warehouse_id = ?2)";
    switch (method) {
        case WriteoffMethod::FIFO: sql += " ORDER BY received_at ASC, id ASC;";  break;
        case WriteoffMethod::LIFO: sql += " ORDER BY received_at DESC, id DESC;"; break;
        case WriteoffMethod::WeightedAverage: sql += ";"; break;
    }

    try {
        utils::SQLiteStatement stmt(db, sql.c_str());
        sqlite3_bind_text(stmt, 1, productIdStd.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(stmt, 2, warehouseId);
        while (sqlite3_step(stmt) == SQLITE_ROW) {
            Row row;
            row.id    = sqlite3_column_int64(stmt, 0);
            row.avail = sqlite3_column_double(stmt, 1);
            row.cost  = sqlite3_column_double(stmt, 2);
            rows.push_back(row);
            totalAvail += row.avail;
        }
    } catch (const std::exception& e) {
        r.success   = false;
        r.errorCode = "DB_ERROR";
        r.errorMsg  = QString::fromStdString(e.what());
        return r;
    }

    // Недостаточно остатка.
    if (totalAvail + kEps < quantity) {
        r.success   = false;
        r.errorCode = "INSUFFICIENT_STOCK";
        r.errorMsg  = QStringLiteral("Недостаточно остатка: доступно %1, запрошено %2")
                          .arg(totalAvail).arg(quantity);
        return r;
    }

    if (method == WriteoffMethod::WeightedAverage) {
        // Средневзвешенная цена доступного остатка.
        const double weighted = std::accumulate(rows.begin(), rows.end(), 0.0,
            [](double s, const Row& r) { return s + r.cost * r.avail; });
        const double avg = (totalAvail > kEps) ? (weighted / totalAvail) : 0.0;

        // Списываем из всех партий пропорционально их доле; остаток округления
        // отдаём последней значимой строке, чтобы сумма совпала с quantity.
        double allocated = 0.0;
        std::size_t lastIdx = rows.size();
        for (std::size_t i = 0; i < rows.size(); ++i) {
            if (rows[i].avail > kEps) lastIdx = i;
        }
        for (std::size_t i = 0; i < rows.size(); ++i) {
            if (rows[i].avail <= kEps) continue;
            double share = (i == lastIdx)
                               ? (quantity - allocated)
                               : (quantity * rows[i].avail / totalAvail);
            if (share <= kEps) continue;
            allocated += share;
            WriteoffLine line;
            line.batchId    = rows[i].id;
            line.quantity   = share;
            line.costPrice  = avg;
            line.lineAmount = share * avg;
            r.lines.push_back(line);
            r.totalCost += line.lineAmount;
        }
        r.avgCost = avg;
    } else {
        // FIFO / LIFO: берём партии по порядку, пока не наберём quantity.
        double remaining = quantity;
        for (const auto& row : rows) {
            if (remaining <= kEps) break;
            double take = std::min(remaining, row.avail);
            if (take <= kEps) continue;
            WriteoffLine line;
            line.batchId    = row.id;
            line.quantity   = take;
            line.costPrice  = row.cost;
            line.lineAmount = take * row.cost;
            r.lines.push_back(line);
            r.totalCost += line.lineAmount;
            remaining   -= take;
        }
        r.avgCost = (quantity > kEps) ? (r.totalCost / quantity) : 0.0;
    }

    r.success = true;
    return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Списание с записью в БД
// ─────────────────────────────────────────────────────────────────────────────
WriteoffResult WriteoffEngine::writeoffInTransaction(sqlite3* db, const QString& productId,
                                                     double quantity, WriteoffMethod method,
                                                     const QString& reason, qint64 documentId,
                                                     int warehouseId) {
    WriteoffResult r = computePlan(db, productId, quantity, method, warehouseId);
    if (!r.success) {
        return r;  // INSUFFICIENT_STOCK/DB_ERROR — транзакция вызывающего откатит
    }

    const std::string reasonStd = reason.toStdString();

    for (const WriteoffLine& line : r.lines) {
        // Уменьшаем остаток партии; при обнулении помечаем 'exhausted'.
        utils::SQLiteStatement upd(db,
            "UPDATE batches "
            "SET quantity = quantity - ?1, "
            "    status = CASE WHEN (quantity - ?1) <= 1e-6 THEN 'exhausted' ELSE status END "
            "WHERE id = ?2;");
        sqlite3_bind_double(upd, 1, line.quantity);
        sqlite3_bind_int64 (upd, 2, line.batchId);
        if (sqlite3_step(upd) != SQLITE_DONE) {
            throw std::runtime_error(std::string("UPDATE batches: ") + sqlite3_errmsg(db));
        }

        // Фиксируем движение списания.
        utils::SQLiteStatement ins(db,
            "INSERT INTO batch_writeoffs"
            "(id, batch_id, quantity, cost_price, reason, document_id, written_by) "
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL);");
        const std::string woId =
            QUuid::createUuid().toString(QUuid::WithoutBraces).toStdString();
        sqlite3_bind_text  (ins, 1, woId.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int64 (ins, 2, line.batchId);
        sqlite3_bind_double(ins, 3, line.quantity);
        sqlite3_bind_double(ins, 4, line.costPrice);
        sqlite3_bind_text  (ins, 5, reasonStd.c_str(), -1, SQLITE_TRANSIENT);
        if (documentId > 0) sqlite3_bind_int64(ins, 6, documentId);
        else                sqlite3_bind_null (ins, 6);
        if (sqlite3_step(ins) != SQLITE_DONE) {
            throw std::runtime_error(std::string("INSERT batch_writeoffs: ") + sqlite3_errmsg(db));
        }
    }

    if (documentId > 0) {
        utils::SQLiteStatement doc(db,
            "UPDATE documents SET updated_at = strftime('%s','now') WHERE id = ?1;");
        sqlite3_bind_int64(doc, 1, documentId);
        if (sqlite3_step(doc) != SQLITE_DONE) {
            throw std::runtime_error(std::string("UPDATE documents: ") + sqlite3_errmsg(db));
        }
    }

    r.success = true;
    return r;
}

void WriteoffEngine::postWriteoffEffects(const QString& productId, double quantity,
                                         const QString& reason, qint64 documentId,
                                         int warehouseId, const WriteoffResult& r) {
    QJsonObject v;
    v["product"]  = productId;
    v["quantity"] = quantity;
    v["total"]    = r.totalCost;
    v["reason"]   = reason;
    smartstock::core::ActionLogger::instance().logCreate("batch_writeoff", documentId, v);

    // Уведомления об остатке (после фиксации).
    const double remaining = availableQuantity(productId, warehouseId);
    const int threshold = smartstock::core::utils::lowStockThreshold();
    if (remaining < threshold) emit lowStockWarning(productId, remaining);
    if (remaining < kEps)      emit stockDepleted(productId);
}

WriteoffResult WriteoffEngine::writeoff(const QString& productId, double quantity, WriteoffMethod method,
                                        const QString& reason, qint64 documentId, int warehouseId) {
    WriteoffResult r;
    auto dbSp = connection();
    sqlite3* db = dbSp.get();
    if (!db) {
        r.errorCode = "DB_ERROR";
        r.errorMsg  = QStringLiteral("Нет соединения с БД");
        return r;
    }

    try {
        Transaction tx(db);
        r = writeoffInTransaction(db, productId, quantity, method, reason, documentId, warehouseId);
        if (!r.success) {
            return r;  // INSUFFICIENT_STOCK/DB_ERROR — Transaction откатит изменения
        }
        tx.commit();
    } catch (const std::exception& e) {
        WriteoffResult err;
        err.success   = false;
        err.errorCode = "DB_ERROR";
        err.errorMsg  = QString::fromStdString(e.what());
        return err;
    }

    postWriteoffEffects(productId, quantity, reason, documentId, warehouseId, r);
    return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Симуляция (только чтение)
// ─────────────────────────────────────────────────────────────────────────────
WriteoffResult WriteoffEngine::simulate(const QString& productId, double quantity,
                                        WriteoffMethod method, int warehouseId) {
    auto dbSp = connection();
    sqlite3* db = dbSp.get();
    if (!db) {
        WriteoffResult r;
        r.errorCode = "DB_ERROR";
        r.errorMsg  = QStringLiteral("Нет соединения с БД");
        return r;
    }
    return computePlan(db, productId, quantity, method, warehouseId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Справочные расчёты
// ─────────────────────────────────────────────────────────────────────────────
double WriteoffEngine::weightedAverageCost(const QString& productId, int warehouseId) {
    const std::string productIdStd = productId.toStdString();
    auto dbSp = connection();
    sqlite3* db = dbSp.get();
    if (!db) return 0.0;
    try {
        utils::SQLiteStatement stmt(db,
            "SELECT CASE WHEN SUM(quantity - reserved) > 1e-6 "
            "            THEN SUM(cost_price * (quantity - reserved)) / SUM(quantity - reserved) "
            "            ELSE 0 END "
            "FROM batches "
            "WHERE product_id = ?1 AND status = 'active' "
            "AND (quantity - reserved) > 1e-6 "
            "AND (?2 = 0 OR warehouse_id = ?2);");
        sqlite3_bind_text(stmt, 1, productIdStd.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(stmt, 2, warehouseId);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            return sqlite3_column_double(stmt, 0);
        }
    } catch (const std::exception&) {
        // невалидное соединение/SQL — возвращаем 0
    }
    return 0.0;
}

double WriteoffEngine::availableQuantity(const QString& productId, int warehouseId) {
    const std::string productIdStd = productId.toStdString();
    auto dbSp = connection();
    sqlite3* db = dbSp.get();
    if (!db) return 0.0;
    try {
        utils::SQLiteStatement stmt(db,
            "SELECT COALESCE(SUM(quantity - reserved), 0) FROM batches "
            "WHERE product_id = ?1 AND status = 'active' "
            "AND (?2 = 0 OR warehouse_id = ?2);");
        sqlite3_bind_text(stmt, 1, productIdStd.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(stmt, 2, warehouseId);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            return sqlite3_column_double(stmt, 0);
        }
    } catch (const std::exception&) {
        // невалидное соединение/SQL — возвращаем 0
    }
    return 0.0;
}

} // namespace smartstock::inventory
