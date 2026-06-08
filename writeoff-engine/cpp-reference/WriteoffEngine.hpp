#pragma once
#include <QObject>
#include <QString>
#include <QList>

struct sqlite3;

namespace smartstock::inventory {

// Метод списания партий.
enum class WriteoffMethod { FIFO, LIFO, WeightedAverage };

// Одна строка списания (привязка к конкретной партии).
struct WriteoffLine {
    qint64 batchId   = 0;
    double quantity  = 0.0;
    double costPrice = 0.0;
    double lineAmount = 0.0;   // quantity * costPrice
};

// Результат списания/симуляции.
struct WriteoffResult {
    bool                success = false;
    QString             errorCode;   // "INSUFFICIENT_STOCK" | "DB_ERROR"
    QString             errorMsg;
    QList<WriteoffLine> lines;
    double              totalCost = 0.0;
    double              avgCost   = 0.0;
};

// ─────────────────────────────────────────────────────────────────────────────
// WriteoffEngine — движок списания партий (FIFO / LIFO / средневзвешенная).
//
// Рассчитан на однопользовательский сценарий без многопоточности: работает с
// единственным соединением SQLite из DatabaseManager. Списание выполняется в
// одной транзакции BEGIN IMMEDIATE (RAII data::Transaction); при нехватке
// остатка или ошибке БД транзакция откатывается целиком.
//
// productId — TEXT-id товара (как в каталоге/CatalogBatchService). warehouseId —
// числовой фильтр (0 = без фильтра по складу).
// ─────────────────────────────────────────────────────────────────────────────
class WriteoffEngine : public QObject {
    Q_OBJECT
public:
    explicit WriteoffEngine(QObject* parent = nullptr);

    // Списание с записью в БД.
    //   reason     — 'sale' | 'return' | 'writeoff' | 'inventory_correction'
    //   documentId — 0 = без документа
    //   warehouseId— 0 = без фильтра по складу
    WriteoffResult writeoff(const QString& productId,
                            double         quantity,
                            WriteoffMethod method,
                            const QString& reason,
                            qint64         documentId,
                            int            warehouseId = 0);

    // Тело списания БЕЗ собственной транзакции — для композиции в чужую
    // data::Transaction (ReservationService::confirm). Меняет batches и пишет
    // batch_writeoffs; бросает std::runtime_error при ошибке SQL (откатит
    // транзакция вызывающего); success=false при INSUFFICIENT_STOCK. Аудит и
    // сигналы НЕ выполняет — вызывающий делает это после commit.
    WriteoffResult writeoffInTransaction(sqlite3* db, const QString& productId,
                                         double quantity, WriteoffMethod method,
                                         const QString& reason, qint64 documentId,
                                         int warehouseId = 0);

    // Аудит + сигналы об остатке — ПОСЛЕ commit (используется writeoff() и
    // ReservationService::confirm, чтобы поведение совпадало).
    void postWriteoffEffects(const QString& productId, double quantity,
                             const QString& reason, qint64 documentId,
                             int warehouseId, const WriteoffResult& r);

    // Только расчёт, без изменения БД — для показа цены в UI до подтверждения.
    WriteoffResult simulate(const QString& productId, double quantity,
                            WriteoffMethod method, int warehouseId = 0);

    // Средневзвешенная себестоимость доступного остатка.
    double weightedAverageCost(const QString& productId, int warehouseId = 0);

    // Доступный остаток = SUM(quantity - reserved) по активным партиям.
    double availableQuantity(const QString& productId, int warehouseId = 0);

signals:
    void stockDepleted(const QString& productId);
    void lowStockWarning(const QString& productId, double remaining);

private:
    // Подбор партий и расчёт строк списания без изменения БД.
    // success=false + errorCode="INSUFFICIENT_STOCK", если остатка не хватает.
    WriteoffResult computePlan(sqlite3* db, const QString& productId, double quantity,
                               WriteoffMethod method, int warehouseId);
};

} // namespace smartstock::inventory
