cmake_minimum_required(VERSION 3.21)
project(SmartStockMessenger VERSION 1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Widgets Network)
qt_standard_project_setup()

# E2E-крипто (libsodium из vcpkg). Опционально на этапе сборки без крипто:
# при наличии — включаем шифрование (дефайн SSM_E2E), иначе клиент собирается
# без шифрования (фаза 1). Имя пакета vcpkg — unofficial-sodium.
find_package(unofficial-sodium CONFIG QUIET)

qt_add_executable(smartstock-messenger WIN32
    src/main.cpp
    src/ApiClient.cpp
    src/Crypto.cpp
    src/LoginWindow.cpp
    src/MainWindow.cpp
)
target_include_directories(smartstock-messenger PRIVATE src)
target_link_libraries(smartstock-messenger PRIVATE Qt6::Widgets Qt6::Network)

if(unofficial-sodium_FOUND)
    target_link_libraries(smartstock-messenger PRIVATE unofficial-sodium::sodium)
    target_compile_definitions(smartstock-messenger PRIVATE SSM_E2E=1)
    message(STATUS "Мессенджер: E2E-шифрование ВКЛ (libsodium найден)")
else()
    message(WARNING "Мессенджер: libsodium НЕ найден — сборка БЕЗ E2E (фаза 1)")
endif()
