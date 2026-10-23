#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace gadm_pop_heat {

struct Options {
    std::string cache_dir;
    std::string gpkg_path;
    double minLng = 0;
    double minLat = 0;
    double maxLng = 0;
    double maxLat = 0;
    int level = 1; // GHS baked on L1+ today; L0 usually empty
    /** Optional ISO3 filter; empty = all countries intersecting bbox. */
    std::string country;
    int candidate_cap = 300;
};

/**
 * Population heatmap points for MapLibre `heatmap` layers.
 *
 * Reads GHS peaks from boundary cache (`ghsPopCenters` / center), caches
 * `popheat_v2_{CC}_L{level}.json` with raw dens/pop.
 *
 * Weight is a **fixed international** score: log10(dens)/4 → 0..1 (not
 * per-country ranks). Returns Point FC:
 *   properties: { gid, country, level, pop, dens, score }
 */
nlohmann::json query_pop_heat(const Options& opts);

} // namespace gadm_pop_heat
