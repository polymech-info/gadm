#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace gadm_neighbors {

struct Options {
    std::string gpkg_path;
    std::string cache_dir;
    std::string gid;
    int level = -1; // -1 = infer from GID dots
    int candidate_cap = 80;
};

/**
 * Same-level border neighbors.
 * Prefers file cache `neighbors_v6_{gid}_L{level}.json`; on miss computes via
 * boundary cache outlines + OGR distance (mutexed GDAL).
 * Returns JSON `{ "data": [ { gid, gadmName, level, lng?, lat? } ] }` or `{ "error": "..." }`.
 */
nlohmann::json get_neighbors(const Options& opts);

} // namespace gadm_neighbors
