#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace gadm_names {

/**
 * Metadata name/GID search against GeoPackage ADM layers (no parquet).
 * Mirrors TS searchRegions / getNames for the common metadata path.
 *
 * Returns { "data": [ { "NAME_n": ..., "GID_n": ... }, ... ] }
 * or { "error": "..." }.
 */
nlohmann::json search_regions(
    const std::string& gpkg_path,
    const std::string& query,
    int content_level = -1, // -1 = search all levels / auto
    const std::string& country = "",
    int limit = 50
);

/**
 * List child region names under an admin GID.
 * Mirrors TS getRegionNames (admin + depth).
 *
 * Returns { "data": [ { "NAME_n": ..., "GID_n": ... }, ... ] }
 * or { "error": "..." }.
 */
nlohmann::json region_names(
    const std::string& gpkg_path,
    const std::string& admin,
    int content_level = -1,
    int depth = 1
);

} // namespace gadm_names
