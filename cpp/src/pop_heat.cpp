#include "pop_heat.h"

#include "cache_paths.h"
#include "gpkg_reader.h"
#include "logger/logger.h"
#include "safety/http_input.hpp"
#include "safety/path_sanitizer.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <unordered_set>
#include <vector>

namespace gadm_pop_heat {

using json = nlohmann::json;
namespace fs = std::filesystem;
using clock = std::chrono::steady_clock;

namespace {

struct RawPt {
    std::string gid;
    std::string country;
    int level = 0;
    double lon = 0;
    double lat = 0;
    double dens = 0; // GHS local peak density (people / 100m cell)
    double pop = 0;  // region total population
};

std::string read_text(const fs::path& p) {
    std::ifstream in(p, std::ios::binary);
    if (!in) return {};
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

void write_text(const fs::path& p, const std::string& body) {
    std::error_code ec;
    fs::create_directories(p.parent_path(), ec);
    std::ofstream out(p, std::ios::binary);
    if (out) out << body;
}

/** v2: raw dens/pop only — no per-country 1–10 ranks. */
fs::path country_cache_path(const fs::path& cache_dir, const std::string& cc, int level) {
    return cache_dir / ("popheat_v2_" + cc + "_L" + std::to_string(level) + ".json");
}

bool point_in_bbox(double lon, double lat, const Options& opts) {
    return lon >= opts.minLng && lon <= opts.maxLng && lat >= opts.minLat && lat <= opts.maxLat;
}

/**
 * Fixed international contribution 0..1 from GHS cell density.
 * Anchors roughly span rural → dense urban (GHS 100m POP cells).
 * Client MapLibre `heatmap-weight` can also interpolate dens directly;
 * we still emit `score` so paint stays stable if dens units change.
 */
double dens_score(double dens) {
    if (!(dens > 0) || !std::isfinite(dens)) return 0.0;
    // log10: 1 → ~0, 10 → 0.25, 100 → 0.5, 1000 → 0.75, 10000 → 1
    const double t = std::log10(dens) / 4.0;
    if (t < 0.0) return 0.0;
    if (t > 1.0) return 1.0;
    return t;
}

void extract_from_fc(const json& fc, const std::string& gid, int level, std::vector<RawPt>& out) {
    if (!fc.contains("features") || !fc["features"].is_array() || fc["features"].empty()) return;
    const auto& props = fc["features"][0].value("properties", json::object());
    const std::string cc = gadm_cache::country_code_from_gid(gid);
    const double pop = props.value("ghsPopulation", 0.0);

    size_t before = out.size();
    if (props.contains("ghsPopCenters") && props["ghsPopCenters"].is_array()) {
        for (const auto& c : props["ghsPopCenters"]) {
            if (!c.is_array() || c.size() < 2) continue;
            RawPt pt;
            pt.gid = gid;
            pt.country = cc;
            pt.level = level;
            pt.lon = c[0].get<double>();
            pt.lat = c[1].get<double>();
            pt.dens = c.size() >= 3 ? c[2].get<double>() : 0.0;
            pt.pop = pop;
            if (!std::isfinite(pt.lon) || !std::isfinite(pt.lat)) continue;
            // Skip zero-density peaks — they polluted Andorra (dens=0 → fake high rank).
            if (!(pt.dens > 0)) continue;
            out.push_back(std::move(pt));
        }
    }
    if (out.size() == before && props.contains("ghsPopCenter") && props["ghsPopCenter"].is_array() &&
        props["ghsPopCenter"].size() >= 2) {
        RawPt pt;
        pt.gid = gid;
        pt.country = cc;
        pt.level = level;
        pt.lon = props["ghsPopCenter"][0].get<double>();
        pt.lat = props["ghsPopCenter"][1].get<double>();
        pt.dens = props.value("ghsPopMaxDensity", 0.0);
        pt.pop = pop;
        if (!std::isfinite(pt.lon) || !std::isfinite(pt.lat)) return;
        if (!(pt.dens > 0)) return;
        out.push_back(std::move(pt));
    }
}

json feature_from_raw(const RawPt& p) {
    return {
        {"type", "Feature"},
        {"geometry", {{"type", "Point"}, {"coordinates", {p.lon, p.lat}}}},
        {"properties",
         {{"gid", p.gid},
          {"country", p.country},
          {"level", p.level},
          {"pop", p.pop},
          {"dens", p.dens},
          {"score", dens_score(p.dens)}}},
    };
}

json load_or_build_country(const fs::path& cache_dir, const std::string& gpkg, const std::string& cc,
                           int level) {
    const fs::path npath = country_cache_path(cache_dir, cc, level);
    if (gadm::path::is_path_inside_root(cache_dir, npath)) {
        std::string cached = read_text(npath);
        if (!cached.empty()) {
            try {
                auto j = json::parse(cached);
                if (j.contains("features") && j["features"].is_array() &&
                    j.value("meta", json::object()).value("version", 0) >= 2) {
                    return j;
                }
            } catch (...) {
            }
        }
    }

    (void)gpkg;
    const fs::path country_dir = cache_dir / cc;
    std::vector<RawPt> raw;
    const std::string suffix = "_" + std::to_string(level) + ".json";
    const std::string map_suffix = "_" + std::to_string(level) + "_map.json";
    std::error_code ec;
    if (fs::is_directory(country_dir, ec)) {
        for (const auto& ent : fs::directory_iterator(country_dir, ec)) {
            if (!ent.is_regular_file(ec)) continue;
            const std::string name = ent.path().filename().string();
            if (name.rfind("boundary_", 0) != 0) continue;
            if (name.size() >= map_suffix.size() &&
                name.compare(name.size() - map_suffix.size(), map_suffix.size(), map_suffix) == 0) {
                continue;
            }
            if (name.size() < suffix.size() ||
                name.compare(name.size() - suffix.size(), suffix.size(), suffix) != 0) {
                continue;
            }
            const std::string mid = name.substr(9, name.size() - 9 - suffix.size());
            if (mid.empty()) continue;
            try {
                extract_from_fc(json::parse(read_text(ent.path())), mid, level, raw);
            } catch (...) {
            }
        }
    }

    // Keep strongest peaks per region (max 3) so microstates don't flood the kernel.
    std::sort(raw.begin(), raw.end(), [](const RawPt& a, const RawPt& b) {
        if (a.gid != b.gid) return a.gid < b.gid;
        return a.dens > b.dens;
    });
    std::vector<RawPt> trimmed;
    trimmed.reserve(raw.size());
    std::string cur;
    int n_cur = 0;
    for (const auto& p : raw) {
        if (p.gid != cur) {
            cur = p.gid;
            n_cur = 0;
        }
        if (n_cur >= 3) continue;
        trimmed.push_back(p);
        ++n_cur;
    }

    json features = json::array();
    for (const auto& p : trimmed) features.push_back(feature_from_raw(p));

    json fc = {
        {"type", "FeatureCollection"},
        {"features", features},
        {"meta",
         {{"version", 2},
          {"country", cc},
          {"level", level},
          {"count", features.size()},
          {"scale", "fixed international log10(dens)/4 → score 0..1"},
          {"densUnit", "GHS POP per 100m cell"}}},
    };
    write_text(npath, fc.dump());
    logger::info("[pop-heat] built v2 " + cc + " L" + std::to_string(level) + " n=" +
                 std::to_string(features.size()));
    return fc;
}

} // namespace

json query_pop_heat(const Options& opts) {
    const auto t0 = clock::now();
    if (opts.level < 0 || opts.level > 5) return json{{"error", "level must be 0–5"}};
    if (!std::isfinite(opts.minLng) || !std::isfinite(opts.minLat) || !std::isfinite(opts.maxLng) ||
        !std::isfinite(opts.maxLat)) {
        return json{{"error", "invalid bbox"}};
    }
    // MapLibre world copies can send lng outside ±180 — fold into WGS84.
    Options box = opts;
    box.minLat = std::clamp(box.minLat, -90.0, 90.0);
    box.maxLat = std::clamp(box.maxLat, -90.0, 90.0);
    if (box.minLat > box.maxLat) std::swap(box.minLat, box.maxLat);
    if (box.maxLng - box.minLng >= 360.0) {
        box.minLng = -180.0;
        box.maxLng = 180.0;
    } else {
        while (box.minLng < -180.0) {
            box.minLng += 360.0;
            box.maxLng += 360.0;
        }
        while (box.minLng >= 180.0) {
            box.minLng -= 360.0;
            box.maxLng -= 360.0;
        }
        if (box.maxLng > 180.0) {
            box.minLng = -180.0;
            box.maxLng = 180.0;
        } else {
            box.minLng = std::clamp(box.minLng, -180.0, 180.0);
            box.maxLng = std::clamp(box.maxLng, -180.0, 180.0);
            if (box.minLng > box.maxLng) std::swap(box.minLng, box.maxLng);
        }
    }
    if (!opts.country.empty() && !gadm::http_input::is_country_code(opts.country)) {
        return json{{"error", "invalid country"}};
    }

    const fs::path cache_dir = fs::absolute(opts.cache_dir);
    const int cap = opts.candidate_cap > 0 ? opts.candidate_cap : 300;

    std::vector<std::string> countries;
    if (!opts.country.empty()) {
        std::string cc = opts.country;
        for (char& c : cc) {
            if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
        }
        countries.push_back(cc);
    } else {
        auto hits = gpkg_reader::query_unique_gids_in_bbox(
            opts.gpkg_path, box.minLng, box.minLat, box.maxLng, box.maxLat, 0, 80);
        std::unordered_set<std::string> seen;
        for (const auto& h : hits) {
            const std::string cc = gadm_cache::country_code_from_gid(h.gid);
            if (cc.empty() || seen.count(cc)) continue;
            seen.insert(cc);
            countries.push_back(cc);
        }
        if (countries.empty()) {
            auto hits2 = gpkg_reader::query_unique_gids_in_bbox(
                opts.gpkg_path, box.minLng, box.minLat, box.maxLng, box.maxLat, opts.level, cap);
            for (const auto& h : hits2) {
                const std::string cc = gadm_cache::country_code_from_gid(h.gid);
                if (cc.empty() || seen.count(cc)) continue;
                seen.insert(cc);
                countries.push_back(cc);
            }
        }
    }

    json features = json::array();
    json metaCountries = json::array();
    for (const auto& cc : countries) {
        json fc = load_or_build_country(cache_dir, opts.gpkg_path, cc, opts.level);
        metaCountries.push_back(cc);
        if (!fc.contains("features")) continue;
        for (auto f : fc["features"]) {
            if (!f.contains("geometry") || !f["geometry"].contains("coordinates")) continue;
            const auto& coords = f["geometry"]["coordinates"];
            if (!coords.is_array() || coords.size() < 2) continue;
            const double lon = coords[0].get<double>();
            const double lat = coords[1].get<double>();
            if (!point_in_bbox(lon, lat, box)) continue;
            // Recompute score if cache predates field (or dens present).
            if (f.contains("properties") && f["properties"].contains("dens")) {
                f["properties"]["score"] = dens_score(f["properties"]["dens"].get<double>());
                f["properties"].erase("w"); // drop old 1–10 if any
            }
            features.push_back(std::move(f));
        }
    }

    const auto ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(clock::now() - t0).count();
    logger::info("[pop-heat] L" + std::to_string(opts.level) + " countries=" +
                 std::to_string(countries.size()) + " pts=" + std::to_string(features.size()) +
                 " " + std::to_string(ms) + "ms");

    return {
        {"type", "FeatureCollection"},
        {"features", features},
        {"meta",
         {{"level", opts.level},
          {"countries", metaCountries},
          {"count", features.size()},
          {"ms", ms},
          {"version", 2},
          {"weight", "score = log10(dens)/4 (fixed international); paint uses dens|score"},
          {"note", "L0 caches often lack GHS — use level>=1"}}},
    };
}

} // namespace gadm_pop_heat
