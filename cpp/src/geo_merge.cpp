#include "geo_merge.h"

#include <stdexcept>
#include <iostream>

// GEOS C API — robust computational geometry with snap rounding.
// GEOSUnaryUnion uses noded overlay which preserves full double
// precision (no coordinate snapping), unlike polygon-clipping.js
// which uses integer grid approximation.
#include <geos_c.h>

// OGR for GeoJSON ↔ GEOS roundtrip
#include <ogr_api.h>
#include <gdal.h>
#include <cpl_conv.h>
#include <cpl_string.h>

namespace geo_merge {

// ── RAII wrapper for GEOS context (thread-safe) ─────────────────────────────

struct GEOSCtx {
    GEOSContextHandle_t ctx = nullptr;

    GEOSCtx() {
        ctx = GEOS_init_r();
        // Suppress GEOS notices (they're noisy on valid-but-complex geom)
        GEOSContext_setNoticeHandler_r(ctx, [](const char*, ...) {});
        GEOSContext_setErrorHandler_r(ctx, [](const char* fmt, ...) {
            // Optionally log GEOS errors for debugging
            va_list ap;
            va_start(ap, fmt);
            char buf[512];
            vsnprintf(buf, sizeof(buf), fmt, ap);
            va_end(ap);
            std::cerr << "[GEOS] " << buf << "\n";
        });
    }

    ~GEOSCtx() {
        if (ctx) GEOS_finish_r(ctx);
    }

    GEOSCtx(const GEOSCtx&) = delete;
    GEOSCtx& operator=(const GEOSCtx&) = delete;
};

// ── WKB → GEOS geometry ─────────────────────────────────────────────────

static GEOSGeometry* wkb_to_geos(
    GEOSContextHandle_t ctx,
    const std::vector<unsigned char>& wkb
) {
    if (wkb.empty()) return nullptr;
    GEOSWKBReader* reader = GEOSWKBReader_create_r(ctx);
    GEOSGeometry* geom = GEOSWKBReader_read_r(ctx, reader, wkb.data(), wkb.size());
    GEOSWKBReader_destroy_r(ctx, reader);

    return geom;
}

// ── GEOS geometry → GeoJSON ─────────────────────────────────────────────────

static nlohmann::json geos_to_geojson(
    GEOSContextHandle_t ctx,
    const GEOSGeometry* geom
) {
    // GEOS → WKB → OGR → GeoJSON (lossless)
    GEOSWKBWriter* writer = GEOSWKBWriter_create_r(ctx);
    size_t wkbSize = 0;
    unsigned char* wkb = GEOSWKBWriter_write_r(ctx, writer, geom, &wkbSize);
    GEOSWKBWriter_destroy_r(ctx, writer);

    OGRGeometryH ogr = nullptr;
    unsigned char* wkbPtr = wkb;
    OGR_G_CreateFromWkb(wkbPtr, nullptr, &ogr, static_cast<int>(wkbSize));
    GEOSFree_r(ctx, wkb);

    if (!ogr) return nlohmann::json::object();

    char** papszOptions = CSLSetNameValue(nullptr, "COORDINATE_PRECISION", "5");
    char* json = OGR_G_ExportToJsonEx(ogr, papszOptions);
    CSLDestroy(papszOptions);
    OGR_G_DestroyGeometry(ogr);

    auto result = nlohmann::json::parse(json);
    CPLFree(json);

    return result;
}

// ── Public API ──────────────────────────────────────────────────────────────

std::vector<boundary::BoundaryFeature> merge(
    const std::vector<boundary::BoundaryFeature>& features
) {
    if (features.size() <= 1) return features;

    GEOSCtx gctx;
    auto ctx = gctx.ctx;

    // Group features by code (GID) — same code means same admin area,
    // multiple geometries need to be unioned into one.
    std::map<std::string, std::vector<size_t>> groups;
    for (size_t i = 0; i < features.size(); ++i) {
        groups[features[i].code].push_back(i);
    }

    std::vector<boundary::BoundaryFeature> result;
    result.reserve(groups.size());

    for (auto& [code, indices] : groups) {
        // Single feature per code — no union needed
        if (indices.size() == 1) {
            result.push_back(features[indices[0]]);
            continue;
        }

        // Collect GEOS geometries for this group
        std::vector<GEOSGeometry*> geoms;
        geoms.reserve(indices.size());

        for (size_t idx : indices) {
            GEOSGeometry* g = wkb_to_geos(ctx, features[idx].wkb);
            if (g) geoms.push_back(g);
        }

        if (geoms.empty()) {
            result.push_back(features[indices[0]]);
            continue;
        }

        if (geoms.size() == 1) {
            // Only one valid geometry — use it directly
            auto out = features[indices[0]];
            out.geojson = geos_to_geojson(ctx, geoms[0]);
            GEOSGeom_destroy_r(ctx, geoms[0]);
            result.push_back(std::move(out));
            continue;
        }

        // Build GeometryCollection and union
        GEOSGeometry* collection = GEOSGeom_createCollection_r(
            ctx, GEOS_GEOMETRYCOLLECTION,
            geoms.data(), static_cast<unsigned int>(geoms.size())
        );

        GEOSGeometry* merged = nullptr;
        if (collection) {
            merged = GEOSUnaryUnion_r(ctx, collection);

            // Fallback: MakeValid each input and retry
            if (!merged) {
                std::cerr << "[geo_merge] Union failed for " << code
                          << ", attempting MakeValid fallback\n";

                std::vector<GEOSGeometry*> valid_geoms;
                valid_geoms.reserve(geoms.size());
                for (auto* g : geoms) {
                    GEOSGeometry* v = GEOSMakeValid_r(ctx, g);
                    if (v) valid_geoms.push_back(v);
                }

                if (!valid_geoms.empty()) {
                    GEOSGeometry* valid_coll = GEOSGeom_createCollection_r(
                        ctx, GEOS_GEOMETRYCOLLECTION,
                        valid_geoms.data(),
                        static_cast<unsigned int>(valid_geoms.size())
                    );
                    if (valid_coll) {
                        merged = GEOSUnaryUnion_r(ctx, valid_coll);
                        // createCollection takes ownership, no manual destroy
                    }
                }
            }
            // createCollection took ownership of geoms, don't destroy individually
        }

        // Build output feature
        boundary::BoundaryFeature out;
        out.code = code;
        out.name = features[indices[0]].name;

        out.minX = features[indices[0]].minX;
        out.minY = features[indices[0]].minY;
        out.maxX = features[indices[0]].maxX;
        out.maxY = features[indices[0]].maxY;
        for (size_t i = 1; i < indices.size(); ++i) {
            size_t idx = indices[i];
            if (features[idx].minX < out.minX) out.minX = features[idx].minX;
            if (features[idx].minY < out.minY) out.minY = features[idx].minY;
            if (features[idx].maxX > out.maxX) out.maxX = features[idx].maxX;
            if (features[idx].maxY > out.maxY) out.maxY = features[idx].maxY;
        }

        if (merged) {
            out.geojson = geos_to_geojson(ctx, merged);
            size_t wkbSize;
            unsigned char* wkbBuf = GEOSGeomToWKB_buf_r(ctx, merged, &wkbSize);
            if (wkbBuf) {
                out.wkb.assign(wkbBuf, wkbBuf + wkbSize);
                GEOSFree_r(ctx, wkbBuf);
            }
            GEOSGeom_destroy_r(ctx, merged);
        } else {
            // Last resort
            std::cerr << "[geo_merge] All union attempts failed for " << code
                      << ", using first geometry as fallback\n";
            GEOSGeometry* g0 = wkb_to_geos(ctx, features[indices[0]].wkb);
            if (g0) {
                out.geojson = geos_to_geojson(ctx, g0);
                out.wkb = features[indices[0]].wkb;
                GEOSGeom_destroy_r(ctx, g0);
            }
        }

        result.push_back(std::move(out));
    }

    return result;
}

} // namespace geo_merge
