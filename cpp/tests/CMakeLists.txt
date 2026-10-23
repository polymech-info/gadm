# ── Test targets ──────────────────────────────────────────────────────────────
include(CTest)

# Catch2 via FetchContent
include(FetchContent)
FetchContent_Declare(
    Catch2
    GIT_REPOSITORY https://github.com/catchorg/Catch2.git
    GIT_TAG        v3.7.1
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(Catch2)
include(Catch)

# Unit: PIP ray-casting
add_executable(test_pip unit/test_pip.cpp)
target_include_directories(test_pip PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_pip PRIVATE Catch2::Catch2WithMain)
catch_discover_tests(test_pip)

# Unit: display clean (holes / islands / coast)
add_executable(test_geo_display unit/test_geo_display.cpp)
target_include_directories(test_geo_display PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_geo_display PRIVATE
    gadm_boundaries_static
    Catch2::Catch2WithMain
)
catch_discover_tests(test_geo_display)
