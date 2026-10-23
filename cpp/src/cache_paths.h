#pragma once

#include <filesystem>
#include <optional>
#include <string>

namespace gadm_cache {

namespace fs = std::filesystem;

/**
 * Resolve a boundary JSON under cache_dir.
 * Prefers map-paint file when want_map is true:
 *   {cache}/{CC}/boundary_{gid}_{level}_map.json
 * then falls back to:
 *   {cache}/{CC}/boundary_{gid}_{level}.json
 *   {cache}/{CC}/boundary_{CC}_{level}.json  (country-wide level dump)
 *   {cache}/boundary_{gid}_{level}.json
 */
std::optional<fs::path> resolve_boundary_cache_file(
    const fs::path& cache_dir,
    const std::string& gid,
    int level,
    bool want_map = true
);

/** ISO3 / GID_0 prefix from a GADM id ("ESP.6_1" → "ESP"). */
std::string country_code_from_gid(const std::string& gid);

} // namespace gadm_cache
