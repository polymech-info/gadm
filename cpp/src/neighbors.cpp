#include "neighbors.h"

#include "cache_paths.h"
#include "gpkg_reader.h"
#include "safety/http_input.hpp"
#include "safety/path_sanitizer.hpp"

#include <ogr_api.h>
#include <cpl_conv.h>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <unordered_set>

namespace gadm_neighbors {

using json = nlohmann::json;
namespace fs = std::filesystem;

static int level_from_gid(const std::string& gid) {
    return static_cast<int>(std::count(gid.begin(), gid.end(), '.'));
}

static std::string safe_gid(const std::string& gid) {
    std::string s = gid;
    for (char& c : s) {
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' ||
              c == '-' || c == '_')) {
            c = '_';
        }
    }
    if (s.size() > 50) s.resize(50);
    return s;
}

static fs::path neighbors_cache_path(const fs::path& cache_dir, const std::string& gid, int level) {
    return cache_dir / ("neighbors_v6_" + safe_gid(gid) + "_L" + std::to_string(level) + ".json");
}

static std::string read_text(const fs::path& p) {
    std::ifstream in(p, std::ios::binary);
    if (!in) return {};
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

static void write_text(const fs::path& p, const std::string& body) {
    std::error_code ec;
    fs::create_directories(p.parent_path(), ec);
    std::ofstream out(p, std::ios::binary);
    if (out) out << body;
}

/** Build one OGR geometry from a FeatureCollection (union of feature geoms). */
static OGRGeometryH geom_from_fc(const json& fc) {
    if (!fc.contains("features") || !fc["features"].is_array()) return nullptr;
    OGRGeometryH collection = nullptr;
    for (const auto& f : fc["features"]) {
        if (!f.contains("geometry") || f["geometry"].is_null()) continue;
        std::string gj = f["geometry"].dump();
        OGRGeometryH g = OGR_G_CreateGeometryFromJson(gj.c_str());
        if (!g) continue;
        if (!collection) {
            collection = g;
        } else {
            OGRGeometryH u = OGR_G_Union(collection, g);
            OGR_G_DestroyGeometry(g);
            if (u) {
                OGR_G_DestroyGeometry(collection);
                collection = u;
            }
        }
    }
    return collection;
}

static void expand_bbox(double& minx, double& miny, double& maxx, double& maxy, double frac) {
    double dx = (maxx - minx) * frac;
    double dy = (maxy - miny) * frac;
    if (dx < 0.05) dx = 0.05;
    if (dy < 0.05) dy = 0.05;
    minx -= dx;
    maxx += dx;
    miny -= dy;
    maxy += dy;
}

json get_neighbors(const Options& opts) {
    std::string gid = opts.gid;
    while (!gid.empty() && (gid.front() == ' ' || gid.front() == '\t')) gid.erase(gid.begin());
    while (!gid.empty() && (gid.back() == ' ' || gid.back() == '\t')) gid.pop_back();
    if (gid.empty()) return json{{"error", "gid is required"}};
    if (!gadm::http_input::is_gadm_gid(gid)) return json{{"error", "invalid gid"}};

    int level = opts.level >= 0 ? opts.level : level_from_gid(gid);
    if (level < 0 || level > 5) return json{{"error", "level must be 0–5"}};

    const fs::path cache_dir = fs::absolute(opts.cache_dir);
    const fs::path npath = neighbors_cache_path(cache_dir, gid, level);
    if (!gadm::path::is_path_inside_root(cache_dir, npath)) {
        return json{{"error", "invalid cache path"}};
    }
    {
        std::string cached = read_text(npath);
        if (!cached.empty()) {
            try {
                auto j = json::parse(cached);
                if (j.contains("data") && j["data"].is_array()) return j;
            } catch (...) {
            }
        }
    }

    auto target_path = gadm_cache::resolve_boundary_cache_file(cache_dir, gid, level, /*want_map=*/false);
    if (!target_path) {
        return json{{"error", "Boundary not found for " + gid}};
    }

    json target_fc;
    try {
        target_fc = json::parse(read_text(*target_path));
    } catch (...) {
        return json{{"error", "Failed to parse boundary cache for " + gid}};
    }

    OGRGeometryH target_g = geom_from_fc(target_fc);
    if (!target_g) return json{{"error", "No geometry for " + gid}};

    OGREnvelope env;
    OGR_G_GetEnvelope(target_g, &env);
    double minx = env.MinX, miny = env.MinY, maxx = env.MaxX, maxy = env.MaxY;
    expand_bbox(minx, miny, maxx, maxy, 0.2);

    // ~100 m at mid-latitudes; L0 looser (~2.5 km) for coarse coasts
    const double gap_deg = (level == 0) ? 0.025 : 0.001;

    auto hits = gpkg_reader::query_unique_gids_in_bbox(
        opts.gpkg_path, minx, miny, maxx, maxy, level, opts.candidate_cap);

    json data = json::array();
    std::unordered_set<std::string> seen;
    seen.insert(gid);

    for (const auto& h : hits) {
        if (h.gid.empty() || seen.count(h.gid)) continue;
        if (level_from_gid(h.gid) != level) continue;
        seen.insert(h.gid);

        auto cpath = gadm_cache::resolve_boundary_cache_file(cache_dir, h.gid, level, false);
        if (!cpath) continue;
        json cfc;
        try {
            cfc = json::parse(read_text(*cpath));
        } catch (...) {
            continue;
        }
        OGRGeometryH cg = geom_from_fc(cfc);
        if (!cg) continue;

        double dist = OGR_G_Distance(target_g, cg);
        OGREnvelope cenv;
        OGR_G_GetEnvelope(cg, &cenv);
        double lng = (cenv.MinX + cenv.MaxX) * 0.5;
        double lat = (cenv.MinY + cenv.MaxY) * 0.5;
        OGR_G_DestroyGeometry(cg);

        bool touches = false;
        if (dist <= gap_deg) {
            touches = true;
        } else {
            // booleanTouches-ish: Distance 0 or Intersects boundary
            // OGR_G_Distance already covers near-touch.
        }
        if (!touches) continue;

        data.push_back({
            {"gid", h.gid},
            {"gadmName", h.name.empty() ? h.gid : h.name},
            {"level", level},
            {"lng", lng},
            {"lat", lat},
        });
    }

    OGR_G_DestroyGeometry(target_g);

    json out = {{"data", data}};
    write_text(npath, out.dump());
    return out;
}

} // namespace gadm_neighbors
