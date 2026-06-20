cmake_minimum_required(VERSION 3.21)
project(WarehouseNavigatorClient VERSION 0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

# Widgets — GUI, Network — встроенный LAN-сервер для телефона (QTcpServer).
find_package(Qt6 REQUIRED COMPONENTS Widgets Network)
qt_standard_project_setup()

qt_add_executable(warehouse-navigator-client WIN32
    src/main.cpp
    src/Snapshot.cpp
    src/NavServer.cpp
    src/MainWindow.cpp
    src/QrImage.cpp
    third_party/qrcodegen/qrcodegen.cpp   # QR-кодировщик Nayuki (MIT)
)
target_include_directories(warehouse-navigator-client PRIVATE src third_party/qrcodegen)
target_link_libraries(warehouse-navigator-client PRIVATE Qt6::Widgets Qt6::Network)
