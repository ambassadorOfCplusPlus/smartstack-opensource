#include "QrImage.hpp"
#include "qrcodegen.hpp"

namespace whnav {

QImage qrToImage(const QString& text, int scale, int border) {
    using qrcodegen::QrCode;
    const QByteArray utf8 = text.toUtf8();
    const QrCode qr = QrCode::encodeText(utf8.constData(), QrCode::Ecc::MEDIUM);
    const int n = qr.getSize();
    const int dim = (n + border * 2) * scale;

    QImage img(dim, dim, QImage::Format_RGB32);
    img.fill(Qt::white);
    const QRgb black = qRgb(0, 0, 0);
    for (int y = 0; y < n; ++y) {
        for (int x = 0; x < n; ++x) {
            if (!qr.getModule(x, y)) continue;
            const int px0 = (x + border) * scale;
            const int py0 = (y + border) * scale;
            for (int dy = 0; dy < scale; ++dy) {
                QRgb* line = reinterpret_cast<QRgb*>(img.scanLine(py0 + dy));
                for (int dx = 0; dx < scale; ++dx) line[px0 + dx] = black;
            }
        }
    }
    return img;
}

} // namespace whnav
