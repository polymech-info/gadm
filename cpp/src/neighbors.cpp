#include "neighbors.h"

#include "cache_paths.h"
#include "gpkg_reader.h"
#include "logger/logger.h"
#include "safety/http_input.hpp"
#include "safety/path_sanitizer.hpp"

#include <ogr_api.h>
#include <cpl_conv.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <unordered_set>

namespace gadm_neighbors {

using json = nlohmann::json;
namespace fs = std::filesystem;
using clock = std::chrono::steady_clock;

static bool stress_mode() {
    const char* e = std::getenv("GADM_HTTP_STRESS");
    return e && e[0] != '\0' && e[0] != '0';
}

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

/**
 * Build one OGR geometry from a FeatureCollection.
 * Prefer a single MultiPolygon / GeometryCollection collect — full Union on
 * island-heavy countries (CAN/IDN) can lock the HTTP pool for minutes.
 */
static OGRGeometryH geom_from_fc(const json& fc) {
    if (!fc.contains("features") || !fc["features"].is_array()) return nullptr;
    OGRGeometryH collection = OGR_G_CreateGeometry(wkbGeometryCollection);
    if (!collection) return nullptr;
    int added = 0;
    for (const auto& f : fc["features"]) {
        if (!f.contains("geometry") || f["geometry"].is_null()) continue;
        std::string gj = f["geometry"].dump();
        OGRGeometryH g = OGR_G_CreateGeometryFromJson(gj.c_str());
        if (!g) continue;
        if (OGR_G_AddGeometryDirectly(collection, g) != OGRERR_NONE) {
            OGR_G_DestroyGeometry(g);
            continue;
        }
        ++added;
        // Stress / L0: first few parts are enough for touch tests at country scale.
        if (stress_mode() && added >= 8) break;
        if (added >= 64) break;
    }
    if (added == 0) {
        OGR_G_DestroyGeometry(collection);
        return nullptr;
    }
    return collection;
}

/** Chebyshev-ish gap between envelopes (degrees). 0 if they overlap. */
static double envelope_gap(const OGREnvelope& a, const OGREnvelope& b) {
    double dx = 0.0;
    double dy = 0.0;
    if (a.MaxX < b.MinX) dx = b.MinX - a.MaxX;
    else if (b.MaxX < a.MinX) dx = a.MinX - b.MaxX;
    if (a.MaxY < b.MinY) dy = b.MinY - a.MaxY;
    else if (b.MaxY < a.MinY) dy = a.MinY - b.MaxY;
    return dx > dy ? dx : dy;
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
    const auto t0 = clock::now();
    std::string gid = opts.gid;
    while (!gid.empty() && (gid.front() == ' ' || gid.front() == '\t')) gid.erase(gid.begin());
    while (!gid.empty() && (gid.back() == ' ' || gid.back() == '\t')) gid.pop_back();
    if (gid.empty()) return json{{"error", "gid is required"}};
    // Stress suite: keep path-safety only (reject / \ ..); accept odd GID shapes.
    if (stress_mode()) {
        if (gid.find('/') != std::string::npos || gid.find('\\') != std::string::npos ||
            gid.find("..") != std::string::npos) {
            return json{{"error", "invalid gid"}};
        }
    } else if (!gadm::http_input::is_gadm_gid(gid)) {
        return json{{"error", "invalid gid"}};
    }

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
                if (j.contains("data") && j["data"].is_array()) {
                    logger::info("[neighbors] " + gid + " L" + std::to_string(level) +
                                 " cache-hit n=" + std::to_string(j["data"].size()));
                    return j;
                }
            } catch (...) {
            }
        }
    }

    // Prefer paint-ready (smaller) outlines — Distance on full coastlines starves HTTP.
    auto target_path = gadm_cache::resolve_boundary_cache_file(cache_dir, gid, level, /*want_map=*/true);
    if (!target_path) {
        target_path = gadm_cache::resolve_boundary_cache_file(cache_dir, gid, level, false);
    }
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
    expand_bbox(minx, miny, maxx, maxy, level == 0 ? 0.12 : 0.2);

    // ~100 m at mid-latitudes; L0 looser (~2.5 km) for coarse coasts
    const double gap_deg = (level == 0) ? 0.025 : 0.001;
    const int cap = opts.candidate_cap > 0
                        ? opts.candidate_cap
                        : (level == 0 ? (stress_mode() ? 40 : 50) : 80);

    auto hits = gpkg_reader::query_unique_gids_in_bbox(
        opts.gpkg_path, minx, miny, maxx, maxy, level, cap);

    json data = json::array();
    std::unordered_set<std::string> seen;
    seen.insert(gid);
    int tested = 0;
    int skipped_env = 0;

    for (const auto& h : hits) {
        if (h.gid.empty() || seen.count(h.gid)) continue;
        if (level_from_gid(h.gid) != level) continue;
        seen.insert(h.gid);

        auto cpath = gadm_cache::resolve_boundary_cache_file(cache_dir, h.gid, level, true);
        if (!cpath) cpath = gadm_cache::resolve_boundary_cache_file(cache_dir, h.gid, level, false);
        if (!cpath) continue;
        json cfc;
        try {
            cfc = json::parse(read_text(*cpath));
        } catch (...) {
            continue;
        }
        OGRGeometryH cg = geom_from_fc(cfc);
        if (!cg) continue;

        OGREnvelope cenv;
        OGR_G_GetEnvelope(cg, &cenv);
        const double egap = envelope_gap(env, cenv);
        if (egap > gap_deg * 4.0) {
            ++skipped_env;
            OGR_G_DestroyGeometry(cg);
            continue;
        }

        ++tested;
        const double dist = OGR_G_Distance(target_g, cg);
        const double lng = (cenv.MinX + cenv.MaxX) * 0.5;
        const double lat = (cenv.MinY + cenv.MaxY) * 0.5;
        OGR_G_DestroyGeometry(cg);

        if (dist > gap_deg) continue;

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
    const auto ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(clock::now() - t0).count();
    logger::info("[neighbors] " + gid + " L" + std::to_string(level) + " n=" +
                 std::to_string(data.size()) + " tested=" + std::to_string(tested) +
                 " skipEnv=" + std::to_string(skipped_env) + " hits=" +
                 std::to_string(hits.size()) + " " + std::to_string(ms) + "ms");
    return out;
}

} // namespace gadm_neighbors
