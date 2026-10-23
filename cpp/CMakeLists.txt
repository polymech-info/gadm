cmake_minimum_required(VERSION 3.20)

project(gadm-boundaries
    VERSION 1.0.0
    DESCRIPTION "GADM Boundaries Batch Generator (C++)"
    LANGUAGES CXX C
)

# ── C++ standard ─────────────────────────────────────────────────────────────
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ── Dependencies via vcpkg find_package ──────────────────────────────────────
find_package(GDAL CONFIG REQUIRED)           # target: GDAL::GDAL
find_package(GEOS CONFIG REQUIRED)           # target: GEOS::geos_c
find_package(PROJ CONFIG REQUIRED)           # target: PROJ::proj
find_package(nlohmann_json CONFIG REQUIRED)  # target: nlohmann_json::nlohmann_json

# CLI11 + cpp-httplib via FetchContent (lightweight, no vcpkg needed)
include(FetchContent)
FetchContent_Declare(
    cli11
    GIT_REPOSITORY https://github.com/CLIUtils/CLI11.git
    GIT_TAG        v2.4.2
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(cli11)

FetchContent_Declare(
    httplib
    GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
    GIT_TAG        v0.18.3
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(httplib)

# ── OpenMP (optional, for country-level parallelism) ─────────────────────────
find_package(OpenMP)

# ── Keep logger package ──────────────────────────────────────────────────────
add_subdirectory(packages/logger)
add_subdirectory(packages/json)

# ── Library sources (everything except main.cpp) ─────────────────────────────
set(GADM_LIB_SOURCES
    src/gpkg_reader.cpp
    src/geo_merge.cpp
    src/ghs_enrich.cpp
    src/geo_display.cpp
    src/cache_paths.cpp
    src/neighbors.cpp
    src/names_search.cpp
)

set(GADM_PUBLIC_HEADERS
    src/gpkg_reader.h
    src/geo_merge.h
    src/ghs_enrich.h
    src/geo_display.h
    src/cache_paths.h
    src/neighbors.h
    src/names_search.h
    src/pip.h
    src/types.h
)

set(GADM_LIB_DEPS
    GDAL::GDAL
    GEOS::geos_c
    PROJ::proj
    nlohmann_json::nlohmann_json
    logger
    json
)

# ── Static library ───────────────────────────────────────────────────────────
add_library(gadm_boundaries_static STATIC ${GADM_LIB_SOURCES})
target_include_directories(gadm_boundaries_static PUBLIC src)
target_link_libraries(gadm_boundaries_static PUBLIC ${GADM_LIB_DEPS})
if(OpenMP_CXX_FOUND)
    target_link_libraries(gadm_boundaries_static PUBLIC OpenMP::OpenMP_CXX)
    target_compile_definitions(gadm_boundaries_static PUBLIC HAS_OPENMP=1)
endif()

# ── Shared library ───────────────────────────────────────────────────────────
add_library(gadm_boundaries SHARED ${GADM_LIB_SOURCES})
target_include_directories(gadm_boundaries PUBLIC src)
target_link_libraries(gadm_boundaries PUBLIC ${GADM_LIB_DEPS})
if(OpenMP_CXX_FOUND)
    target_link_libraries(gadm_boundaries PUBLIC OpenMP::OpenMP_CXX)
    target_compile_definitions(gadm_boundaries PUBLIC HAS_OPENMP=1)
endif()
# Export all symbols on Windows (no __declspec needed)
set_target_properties(gadm_boundaries PROPERTIES WINDOWS_EXPORT_ALL_SYMBOLS ON)

# ── Executable (links against static lib + httplib for `serve`) ─────────────
add_executable(boundaries
    src/main.cpp
    src/http_serve.cpp
)
target_link_libraries(boundaries PRIVATE
    gadm_boundaries_static
    CLI11::CLI11
    httplib::httplib
)
if(WIN32)
    target_link_libraries(boundaries PRIVATE ws2_32)
endif()

# ── Compiler warnings (all targets) ─────────────────────────────────────────
set(_GADM_TARGETS boundaries gadm_boundaries_static gadm_boundaries)
foreach(_tgt IN LISTS _GADM_TARGETS)
    if(MSVC)
        target_compile_options(${_tgt} PRIVATE /W4 /permissive-)
    else()
        target_compile_options(${_tgt} PRIVATE -Wall -Wextra -Wpedantic)
    endif()
endforeach()

# ── Copy data files needed at runtime ────────────────────────────────────────
add_custom_command(TARGET boundaries POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        ${CMAKE_SOURCE_DIR}/../data/gadm_continent.json
        $<TARGET_FILE_DIR:boundaries>/gadm_continent.json
)

# ── Dist — copy release artifacts to ../dist/{platform}/ ─────────────────────
if(WIN32)
    set(DIST_DIR "${CMAKE_SOURCE_DIR}/../dist/win-x64")
else()
    set(DIST_DIR "${CMAKE_SOURCE_DIR}/../dist/linux-x64")
endif()

install(TARGETS boundaries gadm_boundaries_static gadm_boundaries
    RUNTIME DESTINATION "${DIST_DIR}"
    LIBRARY DESTINATION "${DIST_DIR}/lib"
    ARCHIVE DESTINATION "${DIST_DIR}/lib"
)

# Post-build: copy binary so `npm run boundaries:cpp` works from dist
add_custom_command(TARGET boundaries POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${DIST_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        $<TARGET_FILE:boundaries>
        "${DIST_DIR}/"
    COMMENT "Copying boundaries to ${DIST_DIR}/"
)

# Post-build: copy public headers to dist/include/gadm/
add_custom_command(TARGET gadm_boundaries POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${DIST_DIR}/include/gadm"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/src/gpkg_reader.h"  "${DIST_DIR}/include/gadm/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/src/geo_merge.h"    "${DIST_DIR}/include/gadm/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/src/ghs_enrich.h"   "${DIST_DIR}/include/gadm/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/src/geo_display.h"  "${DIST_DIR}/include/gadm/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/src/cache_paths.h"  "${DIST_DIR}/include/gadm/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/src/neighbors.h"    "${DIST_DIR}/include/gadm/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/src/names_search.h" "${DIST_DIR}/include/gadm/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/src/pip.h"          "${DIST_DIR}/include/gadm/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/src/types.h"        "${DIST_DIR}/include/gadm/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/packages/logger/include/logger/logger.h"
        "${DIST_DIR}/include/gadm/"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/packages/json/include/json/json.h"
        "${DIST_DIR}/include/gadm/"
    COMMENT "Copying public headers to ${DIST_DIR}/include/gadm/"
)

# Post-build: copy static library to dist/lib/
add_custom_command(TARGET gadm_boundaries_static POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${DIST_DIR}/lib"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        $<TARGET_FILE:gadm_boundaries_static>
        "${DIST_DIR}/lib/"
    COMMENT "Copying static library to ${DIST_DIR}/lib/"
)

# Post-build: copy shared library (.dll + import lib) to dist/
if(WIN32)
    add_custom_command(TARGET gadm_boundaries POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E make_directory "${DIST_DIR}/lib"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            $<TARGET_FILE:gadm_boundaries>
            "${DIST_DIR}/"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            $<TARGET_LINKER_FILE:gadm_boundaries>
            "${DIST_DIR}/lib/"
        COMMENT "Copying shared library + import lib to ${DIST_DIR}/"
    )
else()
    add_custom_command(TARGET gadm_boundaries POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            $<TARGET_FILE:gadm_boundaries>
            "${DIST_DIR}/"
        COMMENT "Copying shared library to ${DIST_DIR}/"
    )
endif()

# Copy dependent DLLs (Windows) or shared libs + proj.db
if(WIN32)
    add_custom_command(TARGET boundaries POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_directory
            "$<TARGET_FILE_DIR:boundaries>"
            "${DIST_DIR}"
        COMMENT "Copying runtime DLLs to dist/win-x64/"
    )
    # Copy proj.db so PROJ can find its database at runtime
    add_custom_command(TARGET boundaries POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${VCPKG_INSTALLED_DIR}/x64-windows/share/proj/proj.db"
            "${DIST_DIR}/proj.db"
        COMMENT "Copying proj.db to dist/win-x64/"
    )
else()
    # On Linux, proj.db is typically in vcpkg's share/proj or system /usr/share/proj
    if(VCPKG_INSTALLED_DIR)
        set(_PROJ_DB_SEARCH "${VCPKG_INSTALLED_DIR}/x64-linux/share/proj/proj.db")
    else()
        set(_PROJ_DB_SEARCH "/usr/share/proj/proj.db")
    endif()
    add_custom_command(TARGET boundaries POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${_PROJ_DB_SEARCH}"
            "${DIST_DIR}/proj.db"
        COMMENT "Copying proj.db to dist/linux-x64/"
    )
endif()

# ── Tests ────────────────────────────────────────────────────────────────────
enable_testing()
add_subdirectory(tests)
