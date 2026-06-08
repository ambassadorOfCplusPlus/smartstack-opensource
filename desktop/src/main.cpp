#include <QApplication>
#include "ApiClient.hpp"
#include "LoginWindow.hpp"
#include "MainWindow.hpp"
#include "Crypto.hpp"

int main(int argc, char** argv) {
    QApplication app(argc, argv);
    app.setOrganizationName("SmartStock");
    app.setApplicationName("Messenger");
    Crypto::init();

    auto* api = new ApiClient(&app);
    auto* login = new LoginWindow(api);
    QObject::connect(login, &LoginWindow::loggedIn, &app,
                     [api, login](const QString& id, const QString& name) {
        // Не WA_DeleteOnClose: сетевые колбэки захватывают this(MainWindow), а их
        // контекст — ApiClient (живёт весь сеанс). Удаление окна при висящем
        // запросе → use-after-free. Окно живёт до выхода из приложения (закрытие
        // последнего окна завершает приложение, и всё корректно сносится).
        auto* mw = new MainWindow(api, id, name);
        mw->show();
        login->close();
        login->deleteLater();
    });
    login->show();
    return app.exec();
}
