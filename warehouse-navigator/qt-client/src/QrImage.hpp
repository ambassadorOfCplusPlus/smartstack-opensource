// Рендер строки в QR-картинку (QImage) через вендоренный кодировщик Nayuki
// (third_party/qrcodegen, MIT). Используется для печати QR-якорей склада.
#pragma once

#include <QImage>
#include <QString>

namespace whnav {

// Кодирует text в QR (уровень коррекции M). scale — пикселей на модуль, border —
// «тихая зона» в модулях (стандарт — 4). Бросает на слишком длинном тексте.
QImage qrToImage(const QString& text, int scale = 8, int border = 4);

} // namespace whnav
