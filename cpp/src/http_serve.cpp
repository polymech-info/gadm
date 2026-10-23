#include "http_serve.h"

#include "cache_paths.h"
#include "gpkg_reader.h"
#include "logger/logger.h"
#include "names_search.h"
#include "neighbors.h"
#include "pop_heat.h"
#include "safety/http_input.hpp"
#include "safety/path_sanitizer.hpp"
#include "safety/string_utils.hpp"

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

#ifndef PROJECT_VERSION
#define PROJECT_VERSION "1.0.0"
#endif

namespace gadm_http {

using json = nlohmann::json;
namespace fs = std::filesystem;
using clock = std::chrono::steady_clock;

static bool stress_mode() {
    const char* e = std::getenv("GADM_HTTP_STRESS");
    return e && e[0] != '\0' && e[0] != '0';
}

/** Fold MapLibre world-copy longitudes into a single WGS84 bbox (or full globe). */
static bool normalize_wgs84_bbox(double& minLng, double& minLat, double& maxLng, double& maxLat) {
    if (!std::isfinite(minLng) || !std::isfinite(minLat) || !std::isfinite(maxLng) ||
        !std::isfinite(maxLat)) {
        return false;
    }
    minLat = std::clamp(minLat, -90.0, 90.0);
    maxLat = std::clamp(maxLat, -90.0, 90.0);
    if (minLat > maxLat) std::swap(minLat, maxLat);

    if (maxLng - minLng >= 360.0) {
        minLng = -180.0;
        maxLng = 180.0;
        return true;
    }
    while (minLng < -180.0) {
        minLng += 360.0;
        maxLng += 360.0;
    }
    while (minLng >= 180.0) {
        minLng -= 360.0;
        maxLng -= 360.0;
    }
    if (maxLng > 180.0) {
        // Antimeridian cross — expand (client usually splits; this is a safe fallback).
        minLng = -180.0;
        maxLng = 180.0;
        return true;
    }
    minLng = std::clamp(minLng, -180.0, 180.0);
    maxLng = std::clamp(maxLng, -180.0, 180.0);
    if (minLng > maxLng) std::swap(minLng, maxLng);
    return true;
}

/** Path-safe GID check; under GADM_HTTP_STRESS skip strict ISO shape. */
static bool gid_ok(const std::string& gid) {
    if (stress_mode()) {
        if (gid.empty() || gid.size() > gadm::http_input::kMaxGidBytes) return false;
        if (gid.find('/') != std::string::npos || gid.find('\\') != std::string::npos) return false;
        if (gid.find("..") != std::string::npos) return false;
        return true;
    }
    return gadm::http_input::is_gadm_gid(gid);
}

static std::string read_file_bytes(const fs::path& p) {
    std::ifstream in(p, std::ios::binary);
    if (!in) return {};
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

static int parse_int_query(const httplib::Request& req, const char* key, int fallback) {
    if (!req.has_param(key)) return fallback;
    try {
        return std::stoi(req.get_param_value(key));
    } catch (...) {
        return fallback;
    }
}

static double parse_double_query(const httplib::Request& req, const char* key, double fallback) {
    if (!req.has_param(key)) return fallback;
    try {
        return std::stod(req.get_param_value(key));
    } catch (...) {
        return fallback;
    }
}

int run_serve(const ServeOptions& opts) {
    httplib::Server svr;
    // Concurrent MapLibre prefetch — GDAL access is mutexed in gpkg_reader.
    // Stress / pan suite: more workers so one neighbors miss doesn't stall paint.
    const int pool = stress_mode() ? 16 : 8;
    svr.new_task_queue = [pool] { return new httplib::ThreadPool(pool); };

    const fs::path cache_dir = fs::absolute(opts.cache_dir);
    const std::string gpkg = opts.gpkg_path;

    if (stress_mode()) {
        logger::warn("GADM_HTTP_STRESS=1 — loosened GID checks, pool=" + std::to_string(pool));
    }

    svr.Get("/health", [&](const httplib::Request&, httplib::Response& res) {
        json j = {
            {"ok", true},
            {"version", PROJECT_VERSION},
            {"cacheDir", cache_dir.string()},
            {"gpkg", gpkg},
            {"stress", stress_mode()},
        };
        res.set_content(j.dump(), "application/json");
    });

    svr.Get("/v1/regions/hierarchy", [&](const httplib::Request& req, httplib::Response& res) {
        const double lat = parse_double_query(req, "lat", NAN);
        const double lon = parse_double_query(req, "lon", NAN);
        if (!std::isfinite(lat) || !std::isfinite(lon) || lat < -90 || lat > 90 || lon < -180 ||
            lon > 180) {
            res.status = 400;
            res.set_content(json({{"error", "lat and lon are required (finite, in range)"}}).dump(),
                            "application/json");
            return;
        }
        try {
            auto levels = gpkg_reader::get_hierarchy_by_point(gpkg, lat, lon);
            json data = json::array();
            for (const auto& h : levels) {
                json row = {{"level", h.level}};
                row["gid"] = h.gid.empty() ? json(nullptr) : json(h.gid);
                row["gadmName"] = h.name.empty() ? json(nullptr) : json(h.name);
                data.push_back(std::move(row));
            }
            res.set_header("Cache-Control", "public, max-age=3600");
            res.set_content(json({{"data", data}}).dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 500;
            res.set_content(json({{"error", e.what()}}).dump(), "application/json");
        }
    });

    svr.Get("/v1/regions/search", [&](const httplib::Request& req, httplib::Response& res) {
        if (!req.has_param("query") || req.get_param_value("query").empty()) {
            res.status = 400;
            res.set_content(json({{"error", "query is required"}}).dump(), "application/json");
            return;
        }
        const std::string query = req.get_param_value("query");
        if (!gadm::http_input::is_safe_search_query(query)) {
            res.status = 400;
            res.set_content(json({{"error", "invalid query"}}).dump(), "application/json");
            return;
        }
        const int content_level = parse_int_query(req, "content_level", -1);
        if (content_level < -1 || content_level > 5) {
            res.status = 400;
            res.set_content(json({{"error", "content_level out of range"}}).dump(), "application/json");
            return;
        }
        const std::string country = req.has_param("country") ? req.get_param_value("country") : "";
        if (!gadm::http_input::is_country_code(country)) {
            res.status = 400;
            res.set_content(json({{"error", "invalid country"}}).dump(), "application/json");
            return;
        }
        try {
            json out = gadm_names::search_regions(gpkg, query, content_level, country);
            if (out.contains("error")) {
                res.status = 400;
                res.set_content(out.dump(), "application/json");
                return;
            }
            res.set_header("Cache-Control", "public, max-age=300");
            res.set_content(out.dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 500;
            res.set_content(json({{"error", e.what()}}).dump(), "application/json");
        }
    });

    svr.Get("/v1/regions/names", [&](const httplib::Request& req, httplib::Response& res) {
        if (!req.has_param("admin") || req.get_param_value("admin").empty()) {
            res.status = 400;
            res.set_content(json({{"error", "admin is required"}}).dump(), "application/json");
            return;
        }
        const std::string admin = req.get_param_value("admin");
        if (!gid_ok(admin)) {
            res.status = 400;
            res.set_content(json({{"error", "invalid admin gid"}}).dump(), "application/json");
            return;
        }
        const int content_level = parse_int_query(req, "content_level", -1);
        if (content_level < -1 || content_level > 5) {
            res.status = 400;
            res.set_content(json({{"error", "content_level out of range"}}).dump(), "application/json");
            return;
        }
        int depth = 1;
        if (req.has_param("depth")) {
            const std::string d = req.get_param_value("depth");
            if (d == "infinite" || d == "inf" || d == "-1") depth = 5;
            else {
                try { depth = std::stoi(d); } catch (...) { depth = 1; }
            }
        }
        if (depth < 1) depth = 1;
        if (depth > 5) depth = 5;
        try {
            json out = gadm_names::region_names(gpkg, admin, content_level, depth);
            if (out.contains("error")) {
                res.status = 400;
                res.set_content(out.dump(), "application/json");
                return;
            }
            res.set_header("Cache-Control", "public, max-age=3600");
            res.set_content(out.dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 500;
            res.set_content(json({{"error", e.what()}}).dump(), "application/json");
        }
    });

    svr.Get(R"(/v1/regions/boundary/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
        const auto t0 = clock::now();
        const std::string gid = req.matches[1];
        if (!gid_ok(gid)) {
            res.status = 400;
            res.set_content(json({{"error", "invalid gid"}}).dump(), "application/json");
            return;
        }
        int level = parse_int_query(req, "level", -1);
        if (level < 0) {
            // Infer from GID dots: ESP → 0, ESP.6_1 → 1
            level = static_cast<int>(std::count(gid.begin(), gid.end(), '.'));
        }
        if (level < 0 || level > 5) {
            res.status = 400;
            res.set_content(json({{"error", "level out of range"}}).dump(), "application/json");
            return;
        }
        const bool want_map =
            !req.has_param("map") || req.get_param_value("map") == "1" ||
            req.get_param_value("map") == "true" ||
            (req.has_param("simplify") && req.get_param_value("simplify") == "map");

        auto path = gadm_cache::resolve_boundary_cache_file(cache_dir, gid, level, want_map);
        if (!path) {
            const auto ms =
                std::chrono::duration_cast<std::chrono::milliseconds>(clock::now() - t0).count();
            logger::warn("[boundary] miss " + gid + " L" + std::to_string(level) + " map=" +
                         std::to_string(want_map) + " " + std::to_string(ms) + "ms");
            res.status = 404;
            res.set_content(
                json({{"error", "boundary cache miss"}, {"gid", gid}, {"level", level}}).dump(),
                "application/json");
            return;
        }

        std::string body = read_file_bytes(*path);
        if (body.empty()) {
            res.status = 500;
            res.set_content(json({{"error", "failed to read cache file"}}).dump(), "application/json");
            return;
        }

        const auto ms =
            std::chrono::duration_cast<std::chrono::milliseconds>(clock::now() - t0).count();
        logger::info("[boundary] " + gid + " L" + std::to_string(level) + " map=" +
                     std::to_string(want_map) + " file=" + path->filename().string() + " bytes=" +
                     std::to_string(body.size()) + " " + std::to_string(ms) + "ms");

        res.set_header("Cache-Control", "public, max-age=86400");
        // Filename only — never echo full paths to clients.
        res.set_header("X-Gadm-Cache-File", path->filename().string());
        res.set_header("X-Gadm-Ms", std::to_string(ms));
        res.set_content(std::move(body), "application/json");
    });

    svr.Get("/v1/regions/neighbors", [&](const httplib::Request& req, httplib::Response& res) {
        const auto t0 = clock::now();
        if (!req.has_param("gid")) {
            res.status = 400;
            res.set_content(json({{"error", "gid is required"}}).dump(), "application/json");
            return;
        }
        const std::string gid = req.get_param_value("gid");
        if (!gid_ok(gid)) {
            res.status = 400;
            res.set_content(json({{"error", "invalid gid"}}).dump(), "application/json");
            return;
        }
        gadm_neighbors::Options nopts;
        nopts.gpkg_path = gpkg;
        nopts.cache_dir = cache_dir.string();
        nopts.gid = gid;
        nopts.level = parse_int_query(req, "level", -1);
        try {
            json out = gadm_neighbors::get_neighbors(nopts);
            const auto ms =
                std::chrono::duration_cast<std::chrono::milliseconds>(clock::now() - t0).count();
            if (out.contains("error")) {
                logger::warn("[neighbors] " + gid + " err=" + out["error"].get<std::string>() +
                             " " + std::to_string(ms) + "ms");
                res.status = 400;
                res.set_content(out.dump(), "application/json");
                return;
            }
            const size_t n = out.contains("data") && out["data"].is_array() ? out["data"].size() : 0;
            logger::info("[neighbors-http] " + gid + " n=" + std::to_string(n) + " " +
                         std::to_string(ms) + "ms");
            res.set_header("Cache-Control", "public, max-age=86400");
            res.set_header("X-Gadm-Ms", std::to_string(ms));
            res.set_content(out.dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 500;
            res.set_content(json({{"error", e.what()}}).dump(), "application/json");
        }
    });

    // Population heatmap points (GHS centers → MapLibre heatmap-weight `w` 1–10 / country).
    svr.Get("/v1/regions/pop-heat", [&](const httplib::Request& req, httplib::Response& res) {
        const auto t0 = clock::now();
        gadm_pop_heat::Options popts;
        popts.cache_dir = cache_dir.string();
        popts.gpkg_path = gpkg;
        popts.minLng = parse_double_query(req, "minLng", NAN);
        popts.minLat = parse_double_query(req, "minLat", NAN);
        popts.maxLng = parse_double_query(req, "maxLng", NAN);
        popts.maxLat = parse_double_query(req, "maxLat", NAN);
        popts.level = parse_int_query(req, "level", 1);
        if (req.has_param("country")) popts.country = req.get_param_value("country");
        try {
            json out = gadm_pop_heat::query_pop_heat(popts);
            const auto ms =
                std::chrono::duration_cast<std::chrono::milliseconds>(clock::now() - t0).count();
            if (out.contains("error")) {
                res.status = 400;
                res.set_content(out.dump(), "application/json");
                return;
            }
            logger::info("[pop-heat-http] L" + std::to_string(popts.level) + " " +
                         std::to_string(ms) + "ms");
            res.set_header("Cache-Control", "public, max-age=300");
            res.set_header("X-Gadm-Ms", std::to_string(ms));
            res.set_content(out.dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 500;
            res.set_content(json({{"error", e.what()}}).dump(), "application/json");
        }
    });

    svr.Get("/v1/regions/in-viewport", [&](const httplib::Request& req, httplib::Response& res) {
        const auto t0 = clock::now();
        const double minLng = parse_double_query(req, "minLng", NAN);
        const double minLat = parse_double_query(req, "minLat", NAN);
        const double maxLng = parse_double_query(req, "maxLng", NAN);
        const double maxLat = parse_double_query(req, "maxLat", NAN);
        const int level = parse_int_query(req, "level", -1);
        const int cap = level == 0 ? 80 : 300;

        double west = minLng, south = minLat, east = maxLng, north = maxLat;
        if (level < 0 || level > 5 || !normalize_wgs84_bbox(west, south, east, north)) {
            res.status = 400;
            res.set_content(json({{"error", "need minLng,minLat,maxLng,maxLat,level(0-5)"}}).dump(),
                            "application/json");
            return;
        }

        try {
            auto hits = gpkg_reader::query_unique_gids_in_bbox(
                gpkg, west, south, east, north, level, cap);
            json data = json::array();
            for (const auto& h : hits) {
                data.push_back({{"gid", h.gid}, {"gadmName", h.name}, {"level", level}});
            }
            const auto ms =
                std::chrono::duration_cast<std::chrono::milliseconds>(clock::now() - t0).count();
            logger::info("[viewport] L" + std::to_string(level) + " n=" + std::to_string(data.size()) +
                         " " + std::to_string(ms) + "ms");
            res.set_header("Cache-Control", "public, max-age=120");
            res.set_header("X-Gadm-Ms", std::to_string(ms));
            res.set_content(json({{"data", data}}).dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 500;
            res.set_content(json({{"error", e.what()}}).dump(), "application/json");
        }
    });

    // Safe cache file serve — never use raw set_mount_point (path traversal risk).
    svr.Get(R"(/cache/(.*))", [&](const httplib::Request& req, httplib::Response& res) {
        const std::string rel = req.matches.size() > 1 ? std::string(req.matches[1]) : std::string();
        if (rel.size() > gadm::http_input::kMaxCacheRelPathBytes) {
            res.status = 400;
            res.set_content(json({{"error", "path too long"}}).dump(), "application/json");
            return;
        }
        std::string err;
        fs::path resolved = gadm::path::resolve_under_root(cache_dir, rel, err);
        if (resolved.empty() || !err.empty()) {
            res.status = 403;
            res.set_content(json({{"error", err.empty() ? "forbidden" : err}}).dump(),
                            "application/json");
            return;
        }
        std::error_code ec;
        if (!fs::is_regular_file(resolved, ec) || ec) {
            res.status = 404;
            res.set_content(json({{"error", "not found"}}).dump(), "application/json");
            return;
        }
        // Cap file size to avoid DoS via huge accidental dumps.
        const auto sz = fs::file_size(resolved, ec);
        if (ec || sz == 0 || sz > 64ull * 1024ull * 1024ull) {
            res.status = 413;
            res.set_content(json({{"error", "file too large or empty"}}).dump(), "application/json");
            return;
        }
        std::string body = read_file_bytes(resolved);
        if (body.empty()) {
            res.status = 500;
            res.set_content(json({{"error", "read failed"}}).dump(), "application/json");
            return;
        }
        const auto ext = gadm::strutil::lower_ascii(resolved.extension().string());
        const char* ctype = (ext == ".json") ? "application/json" : "application/octet-stream";
        res.set_header("Cache-Control", "public, max-age=3600");
        res.set_content(std::move(body), ctype);
    });

    logger::info("gadm-http listening on http://" + opts.host + ":" + std::to_string(opts.port) +
                 " cache=" + cache_dir.string());

    if (!svr.listen(opts.host.c_str(), opts.port)) {
        logger::error("gadm-http failed to bind " + opts.host + ":" + std::to_string(opts.port));
        return 1;
    }
    return 0;
}

} // namespace gadm_http
