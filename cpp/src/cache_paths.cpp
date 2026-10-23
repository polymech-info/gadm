#include "cache_paths.h"

#include "safety/http_input.hpp"
#include "safety/path_sanitizer.hpp"

#include <algorithm>

namespace gadm_cache {

std::string country_code_from_gid(const std::string& gid) {
    auto dot = gid.find('.');
    if (dot == std::string::npos) return gid;
    return gid.substr(0, dot);
}

static bool usable(const fs::path& p) {
    std::error_code ec;
    return fs::is_regular_file(p, ec) && fs::file_size(p, ec) > 0 && !ec;
}

std::optional<fs::path> resolve_boundary_cache_file(
    const fs::path& cache_dir,
    const std::string& gid,
    int level,
    bool want_map
) {
    if (gid.empty() || level < 0 || level > 5) return std::nullopt;
    // GID is concatenated into filenames — reject traversal / separators first.
    if (!gadm::http_input::is_gadm_gid(gid)) return std::nullopt;

    const std::string cc = country_code_from_gid(gid);
    if (!gadm::path::is_safe_path_component(cc)) return std::nullopt;

    const std::string lvl = std::to_string(level);
    const fs::path country_dir = cache_dir / cc;

    auto try_path = [&](const fs::path& p) -> std::optional<fs::path> {
        if (!gadm::path::is_path_inside_root(cache_dir, p)) return std::nullopt;
        if (usable(p)) return p;
        return std::nullopt;
    };

    if (want_map) {
        if (auto p = try_path(country_dir / ("boundary_" + gid + "_" + lvl + "_map.json"))) return p;
        if (auto p = try_path(cache_dir / ("boundary_" + gid + "_" + lvl + "_map.json"))) return p;
        // Display-cleaned country dumps often keep the non-_map name after --display-clean.
    }

    if (auto p = try_path(country_dir / ("boundary_" + gid + "_" + lvl + ".json"))) return p;
    if (gid == cc) {
        if (auto p = try_path(country_dir / ("boundary_" + cc + "_" + lvl + ".json"))) return p;
    }
    if (auto p = try_path(cache_dir / ("boundary_" + gid + "_" + lvl + ".json"))) return p;
    if (gid == cc) {
        if (auto p = try_path(cache_dir / ("boundary_" + cc + "_" + lvl + ".json"))) return p;
    }

    // Last resort: map-named even when want_map=false (already paint-ready).
    if (!want_map) {
        if (auto p = try_path(country_dir / ("boundary_" + gid + "_" + lvl + "_map.json"))) return p;
    }

    return std::nullopt;
}

} // namespace gadm_cache
