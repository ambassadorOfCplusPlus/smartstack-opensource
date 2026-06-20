#include <QApplication>
#include "MainWindow.hpp"

int main(int argc, char* argv[]) {
    QApplication app(argc, argv);
    QApplication::setApplicationName(QStringLiteral("Навигатор по складу — ПК-клиент"));
    whnav::MainWindow w;
    w.show();
    return app.exec();
}
