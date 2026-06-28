cmake_minimum_required(VERSION 3.16)
project(aitc LANGUAGES CXX)

# Header-only interface library. C++17 (structured bindings, std::optional) — no
# C++20/23 features, to maximise adoption.
add_library(aitc INTERFACE)
target_include_directories(aitc INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(aitc INTERFACE cxx_std_17)

# nlohmann/json — prefer an installed package (vcpkg/system), else fetch it.
find_package(nlohmann_json QUIET)
if(NOT nlohmann_json_FOUND)
    include(FetchContent)
    FetchContent_Declare(nlohmann_json
        URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz)
    FetchContent_MakeAvailable(nlohmann_json)
endif()
target_link_libraries(aitc INTERFACE nlohmann_json::nlohmann_json)

option(AITC_EXAMPLES "Build examples" ON)
option(AITC_TESTS    "Build tests"    ON)

if(AITC_EXAMPLES)
    add_executable(calc_demo examples/calc_demo.cpp)
    target_link_libraries(calc_demo PRIVATE aitc)
endif()

if(AITC_TESTS)
    enable_testing()
    find_package(GTest QUIET)
    if(NOT GTest_FOUND)
        include(FetchContent)
        FetchContent_Declare(googletest
            URL https://github.com/google/googletest/archive/refs/tags/v1.14.0.tar.gz)
        set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
        FetchContent_MakeAvailable(googletest)
    endif()
    add_executable(aitc_tests tests/test_aitc.cpp)
    target_link_libraries(aitc_tests PRIVATE aitc GTest::gtest_main)
    include(GoogleTest)
    gtest_discover_tests(aitc_tests)
endif()
