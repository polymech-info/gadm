#pragma once

#include <string>

namespace gadm_http {

struct ServeOptions {
    std::string host = "127.0.0.1";
    int port = 3340;
    std::string cache_dir = "cache/gadm";
    std::string gpkg_path = "data/gadm_410.gpkg";
};

/** Blocking HTTP server (loopback geom + file serve). Returns process exit code. */
int run_serve(const ServeOptions& opts);

} // namespace gadm_http
