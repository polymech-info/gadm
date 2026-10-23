#include "http_serve.h"

#include "cache_paths.h"
#include "gpkg_reader.h"
#include "logger/logger.h"
#include "names_search.h"
#include "neighbors.h"

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
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
    // Concurrent MapLibre prefetch — default pool; GDAL access is mutexed in gpkg_reader.
    svr.new_task_queue = [] { return new httplib::ThreadPool(8); };

    const fs::path cache_dir = fs::absolute(opts.cache_dir);
    const std::string gpkg = opts.gpkg_path;

    svr.Get("/health", [&](const httplib::Request&, httplib::Response& res) {
        json j = {
            {"ok", true},
            {"version", PROJECT_VERSION},
            {"cacheDir", cache_dir.string()},
            {"gpkg", gpkg},
        };
        res.set_content(j.dump(), "application/json");
    });

    svr.Get("/v1/regions/hierarchy", [&](const httplib::Request& req, httplib::Response& res) {
        const double lat = parse_double_query(req, "lat", NAN);
        const double lon = parse_double_query(req, "lon", NAN);
        if (!std::isfinite(lat) || !std::isfinite(lon)) {
            res.status = 400;
            res.set_content(json({{"error", "lat and lon are required"}}).dump(), "application/json");
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
        const int content_level = parse_int_query(req, "content_level", -1);
        const std::string country = req.has_param("country") ? req.get_param_value("country") : "";
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
        const int content_level = parse_int_query(req, "content_level", -1);
        int depth = 1;
        if (req.has_param("depth")) {
            const std::string d = req.get_param_value("depth");
            if (d == "infinite" || d == "inf" || d == "-1") depth = 5;
            else {
                try { depth = std::stoi(d); } catch (...) { depth = 1; }
            }
        }
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
        const std::string gid = req.matches[1];
        int level = parse_int_query(req, "level", -1);
        if (level < 0) {
            // Infer from GID dots: ESP → 0, ESP.6_1 → 1
            level = static_cast<int>(std::count(gid.begin(), gid.end(), '.'));
        }
        const bool want_map =
            !req.has_param("map") || req.get_param_value("map") == "1" ||
            req.get_param_value("map") == "true" ||
            (req.has_param("simplify") && req.get_param_value("simplify") == "map");

        auto path = gadm_cache::resolve_boundary_cache_file(cache_dir, gid, level, want_map);
        if (!path) {
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

        res.set_header("Cache-Control", "public, max-age=86400");
        res.set_header("X-Gadm-Cache-File", path->filename().string());
        res.set_content(std::move(body), "application/json");
    });

    svr.Get("/v1/regions/neighbors", [&](const httplib::Request& req, httplib::Response& res) {
        if (!req.has_param("gid")) {
            res.status = 400;
            res.set_content(json({{"error", "gid is required"}}).dump(), "application/json");
            return;
        }
        gadm_neighbors::Options nopts;
        nopts.gpkg_path = gpkg;
        nopts.cache_dir = cache_dir.string();
        nopts.gid = req.get_param_value("gid");
        nopts.level = parse_int_query(req, "level", -1);
        try {
            json out = gadm_neighbors::get_neighbors(nopts);
            if (out.contains("error")) {
                res.status = 400;
                res.set_content(out.dump(), "application/json");
                return;
            }
            res.set_header("Cache-Control", "public, max-age=86400");
            res.set_content(out.dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 500;
            res.set_content(json({{"error", e.what()}}).dump(), "application/json");
        }
    });

    svr.Get("/v1/regions/in-viewport", [&](const httplib::Request& req, httplib::Response& res) {
        const double minLng = parse_double_query(req, "minLng", NAN);
        const double minLat = parse_double_query(req, "minLat", NAN);
        const double maxLng = parse_double_query(req, "maxLng", NAN);
        const double maxLat = parse_double_query(req, "maxLat", NAN);
        const int level = parse_int_query(req, "level", -1);
        const int cap = level == 0 ? 80 : 300;

        if (!std::isfinite(minLng) || !std::isfinite(minLat) || !std::isfinite(maxLng) ||
            !std::isfinite(maxLat) || level < 0 || level > 5) {
            res.status = 400;
            res.set_content(json({{"error", "need minLng,minLat,maxLng,maxLat,level(0-5)"}}).dump(),
                            "application/json");
            return;
        }

        try {
            auto hits = gpkg_reader::query_unique_gids_in_bbox(
                gpkg, minLng, minLat, maxLng, maxLat, level, cap);
            json data = json::array();
            for (const auto& h : hits) {
                data.push_back({{"gid", h.gid}, {"gadmName", h.name}, {"level", level}});
            }
            res.set_header("Cache-Control", "public, max-age=120");
            res.set_content(json({{"data", data}}).dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 500;
            res.set_content(json({{"error", e.what()}}).dump(), "application/json");
        }
    });

    // Optional static mount of cache tree (dev / direct MapLibre)
    const std::string mount = cache_dir.string();
    if (!svr.set_mount_point("/cache", mount)) {
        logger::warn("http serve: could not mount /cache at " + mount);
    }

    logger::info("gadm-http listening on http://" + opts.host + ":" + std::to_string(opts.port) +
                 " cache=" + cache_dir.string());

    if (!svr.listen(opts.host.c_str(), opts.port)) {
        logger::error("gadm-http failed to bind " + opts.host + ":" + std::to_string(opts.port));
        return 1;
    }
    return 0;
}

} // namespace gadm_http
