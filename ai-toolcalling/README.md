# aitc — локальный LLM с tool-calling для C++

Маленькое **ядро для tool-calling** на локальных LLM. Приносишь **свою модель**
(реализуешь `IGenerator`) и **свои инструменты** (регистрируешь колбэки в
`ToolRegistry`) — `aitc` берёт на себя остальное: **терпимый парсер** форматов
вызова, которые выдают слабые модели, **детерминированный агент-цикл** (модель
предлагает вызовы → **исполняешь ты** → результаты возвращаются модели), снятие
тегов рассуждения `<think>` и сборку системного промпта. Без БД, без сети, без
вшитого фреймворка. Ядро — чистый C++17 + `nlohmann/json`, тестируется
мок-генератором без модели.

> Short EN: a tiny **local-LLM tool-calling core** for C++. Bring your own model
> (`IGenerator`) and your own tools (`ToolRegistry`); aitc gives you a tolerant
> parser for the shapes small models emit, a deterministic agent loop (the model
> proposes calls, *you* execute them), `<think>`-tag stripping, and a system-prompt
> builder. Header-only, C++17, nlohmann/json. Tested with a mock generator — no
> model needed. MIT.

## Почему

Слабые локальные модели (3–8B) **конфабулируют**, если дать им «самим вызывать
функции»: выдумывают имена инструментов, числа, аргументы. Надёжнее — **план-протокол**:
модель отдаёт JSON-план вызовов, а исполняет их **детерминированный код** против
авторитетного реестра инструментов. `aitc` — это ровно такой каркас, выделенный из
[SmartStock](https://github.com/ambassadorOfCplusPlus/smartstack-opensource) и
обкатанный на бенче из 13 локальных моделей (см. [`docs/RESEARCH.md`](docs/RESEARCH.md)).

Терпимый парсер тащит реальный «зоопарк» выводов: массив `[{…}]`, обёртку
`{"plan":[…]}`, одиночный объект, ключи `tool|name` и `args|arguments|parameters|params`,
JSON среди прозы, и даже лёгкий ремонт битого JSON (лишняя кавычка после числа,
хвостовая запятая).

## 60 секунд

```cpp
#include "aitc/aitc.hpp"

aitc::ToolRegistry reg;
reg.add("add", "Add two numbers", R"({"a":<num>,"b":<num>})",
        [](const nlohmann::json& a) {
            return std::to_string(a.value("a", 0.0) + a.value("b", 0.0));
        });

MyLlama gen("model.gguf");                       // реализует aitc::IGenerator
auto r = aitc::runAgent(gen, reg, "Сколько будет 2 + 3?");
// r.answer  — финальный текст модели
// r.calls   — какие инструменты были вызваны (для аудита/логов)
```

Подключить свой инструмент — буквально `reg.add(name, description, hint, callback)`.
Полный гайд: [`docs/PLATFORM.md`](docs/PLATFORM.md).

## Сборка и тесты

Header-only — достаточно положить `include/` в include-пути. Для примеров/тестов:

```bash
cmake -S . -B build            # найдёт nlohmann/json и GTest (vcpkg/system) либо скачает
cmake --build build
ctest --test-dir build         # 45 тестов: парсер, реестр, протоколы, агент-цикл (мок-модель)
./build/calc_demo              # сквозное демо без реальной LLM
```

Зависимость рантайма одна — `nlohmann/json` (header-only). Модель **не** входит:
её приносишь через `IGenerator` (адаптер к llama.cpp / HTTP / чему угодно).

## Что внутри

| Файл | |
|---|---|
| [`include/aitc/aitc.hpp`](include/aitc/aitc.hpp) | всё ядро (header-only): типы, реестр, парсер, агент-цикл |
| [`examples/calc_demo.cpp`](examples/calc_demo.cpp) | сквозное демо со «скриптовой» моделью |
| [`tests/test_aitc.cpp`](tests/test_aitc.cpp) | 45 тестов (парсер/реестр/протоколы/агент) |
| [`docs/PLATFORM.md`](docs/PLATFORM.md) | как подключить свой инструмент и свою модель |
| [`docs/DESIGN.md`](docs/DESIGN.md) | архитектура: мозг/движок, протоколы, агент-цикл |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | бенч 13 локальных моделей: что выбрать и почему |

## Лицензия

MIT (см. [LICENSE](LICENSE)). Выделено из проекта SmartStock; используйте независимо.
