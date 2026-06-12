#pragma once
// ─────────────────────────────────────────────────────────────────────────────
// MsgFlags — компактная упаковка «технических флагов» сообщения в ОДИН 64-битный
// integer (quint64) с разбором битовыми операциями. Идея: вместо нескольких
// JSON-ключей в E2E-payload (тип, ответ-ли, правка, удаление…) держим одно число
// `f` — это дешевле по трафику (со всего потока расшифровывает лишь адресат, но
// флаги распаковывают все) и быстрее разбирается на C++.
//
// Раскладка битов (LSB → MSB), согласована с веб-клиентом (web/index.html, MsgFlags):
//   биты  0..7  : kind (uint8) — вид сообщения (Text/File/React/Voice/System)
//   бит   8     : reply   — это ответ на другое сообщение
//   бит   9     : edit    — правка ранее отправленного
//   бит   10    : delete  — техническое сообщение «удалить»
//   биты 11..63 : резерв (расширения)
//
// Всё constexpr — упаковка/распаковка считается на этапе компиляции, а static_assert
// ниже ПРОВЕРЯЮТ корректность раскладки прямо при сборке (нулевая цена в рантайме).
// ─────────────────────────────────────────────────────────────────────────────

#include <QtGlobal>  // quint8 / quint64

namespace msg {

enum Kind : quint8 {
    Text   = 0,
    File   = 1,
    React  = 2,
    Voice  = 3,
    System = 4,
};

constexpr quint64 KIND_MASK = 0xFFull;        // младший байт — вид
constexpr quint64 F_REPLY   = 1ull << 8;
constexpr quint64 F_EDIT    = 1ull << 9;
constexpr quint64 F_DELETE  = 1ull << 10;

// Упаковать вид + булевы флаги в одно число.
constexpr quint64 pack(Kind k, bool reply = false, bool edit = false, bool del = false) {
    return (static_cast<quint64>(k) & KIND_MASK)
         | (reply ? F_REPLY : 0ull)
         | (edit  ? F_EDIT  : 0ull)
         | (del   ? F_DELETE : 0ull);
}

// Распаковка битовыми операциями.
constexpr Kind kind(quint64 f)     { return static_cast<Kind>(f & KIND_MASK); }
constexpr bool isReply(quint64 f)  { return (f & F_REPLY)  != 0ull; }
constexpr bool isEdit(quint64 f)   { return (f & F_EDIT)   != 0ull; }
constexpr bool isDelete(quint64 f) { return (f & F_DELETE) != 0ull; }

// ── Проверки раскладки на этапе компиляции (если что-то разъедется — не соберётся) ──
static_assert(pack(Text) == 0ull, "Text должен паковаться в 0");
static_assert(pack(React) == 2ull, "React == 2 (совместимо с веб)");
static_assert(kind(pack(File)) == File, "round-trip kind");
static_assert(kind(pack(System, true, true, true)) == System, "kind при всех флагах");
static_assert(isReply(pack(Text, true)) && !isEdit(pack(Text, true)), "только reply");
static_assert(isEdit(pack(File, false, true)) && !isDelete(pack(File, false, true)), "только edit");
static_assert(isDelete(pack(Voice, false, false, true)), "delete-бит");
static_assert(pack(System, true, true, true) == (4ull | F_REPLY | F_EDIT | F_DELETE), "полная маска");

} // namespace msg
