#include "gpkg_reader.h"

#include <cstdio>
#include <sstream>
#include <stdexcept>
#include <map>
#include <mutex>
#include <unordered_set>
#include <nlohmann/json.hpp>

// GDAL/OGR C API
#include <gdal.h>
#include <ogr_api.h>
#include <cpl_conv.h>
#include <cpl_string.h>

namespace gpkg_reader {

static GDALDatasetH g_ds = nullptr;
static std::string g_current_gpkg = "";
/** GDAL datasets / layers are not safe for concurrent readers on one handle. */
static std::mutex g_gpkg_mutex;

static void ensure_open(const std::string& gpkg_path) {
    // Caller must hold g_gpkg_mutex.
    if (!g_ds || g_current_gpkg != gpkg_path) {
        if (g_ds) GDALClose(g_ds);
        GDALAllRegister();
        // Try opening in update mode to create indices
        g_ds = GDALOpenEx(
            gpkg_path.c_str(), GDAL_OF_VECTOR | GDAL_OF_UPDATE,
            nullptr, nullptr, nullptr
        );
        if (g_ds) {
            // Build indices to make reads / name search usable on flat gadm_410.
            for (int i = 0; i < GDALDatasetGetLayerCount(g_ds); ++i) {
                OGRLayerH l = GDALDatasetGetLayer(g_ds, i);
                if (!l) continue;
                std::string lname = OGR_L_GetName(l);
                const char* idx_sqls[] = {
                    "CREATE INDEX IF NOT EXISTS idx_%s_gid0 ON \"%s\" (GID_0)",
                    "CREATE INDEX IF NOT EXISTS idx_%s_name0 ON \"%s\" (NAME_0)",
                    "CREATE INDEX IF NOT EXISTS idx_%s_name1 ON \"%s\" (NAME_1)",
                    "CREATE INDEX IF NOT EXISTS idx_%s_name2 ON \"%s\" (NAME_2)",
                    "CREATE INDEX IF NOT EXISTS idx_%s_gid1 ON \"%s\" (GID_1)",
                    "CREATE INDEX IF NOT EXISTS idx_%s_gid2 ON \"%s\" (GID_2)",
                };
                for (const char* fmt : idx_sqls) {
                    char sql[512];
                    std::snprintf(sql, sizeof(sql), fmt, lname.c_str(), lname.c_str());
                    OGRLayerH res = GDALDatasetExecuteSQL(g_ds, sql, nullptr, "SQLite");
                    if (res) GDALDatasetReleaseResultSet(g_ds, res);
                }
            }
        } else {
            // Fallback to read-only
            g_ds = GDALOpenEx(
                gpkg_path.c_str(), GDAL_OF_VECTOR | GDAL_OF_READONLY,
                nullptr, nullptr, nullptr
            );
        }
        if (!g_ds) {
            throw std::runtime_error("Cannot open GeoPackage: " + gpkg_path);
        }
        g_current_gpkg = gpkg_path;
    }
}

std::vector<std::string> get_subregions(
    const std::string& gpkg_path,
    const std::string& country_code,
    int split_level
) {
    std::lock_guard<std::mutex> lock(g_gpkg_mutex);
    ensure_open(gpkg_path);
    GDALDatasetH ds = g_ds;

    std::string layer_name = "ADM_ADM_" + std::to_string(split_level);
    OGRLayerH layer = GDALDatasetGetLayerByName(ds, layer_name.c_str());
    if (!layer) {
        layer = GDALDatasetGetLayer(ds, split_level);
        if (!layer) layer = GDALDatasetGetLayer(ds, 0);
    }
    if (!layer) return {};
    
    std::string actual_layer_name = OGR_L_GetName(layer);
    std::string sql = "SELECT DISTINCT GID_" + std::to_string(split_level) + " FROM \"" + actual_layer_name + "\" WHERE GID_0 = '" + country_code + "'";
    
    OGRLayerH query_layer = GDALDatasetExecuteSQL(ds, sql.c_str(), nullptr, "SQLite");
    if (!query_layer) return {};

    std::vector<std::string> subregions;
    OGRFeatureH feat;
    OGR_L_ResetReading(query_layer);
    while ((feat = OGR_L_GetNextFeature(query_layer)) != nullptr) {
        const char* val = OGR_F_GetFieldAsString(feat, 0);
        if (val) {
            subregions.push_back(val);
        }
        OGR_F_Destroy(feat);
    }
    GDALDatasetReleaseResultSet(ds, query_layer);
    
    return subregions;
}

std::vector<boundary::BoundaryFeature> read_features(
    const std::string& gpkg_path,
    const std::string& country_code,
    int level,
    double tolerance
) {
    std::lock_guard<std::mutex> lock(g_gpkg_mutex);
    ensure_open(gpkg_path);

    GDALDatasetH ds = g_ds;

    // Parse dot_count for country_code filtering (e.g. ESP.6_1)
    std::string gadm_id = country_code;
    int dot_count = std::count(gadm_id.begin(), gadm_id.end(), '.');
    std::string iso_code = dot_count > 0 ? gadm_id.substr(0, gadm_id.find('.')) : gadm_id;

    // Find the correct layer and its actual name
    std::string layer_name = "ADM_ADM_" + std::to_string(level);
    OGRLayerH layer = GDALDatasetGetLayerByName(ds, layer_name.c_str());
    if (!layer) {
        layer = GDALDatasetGetLayer(ds, level);
        if (!layer) layer = GDALDatasetGetLayer(ds, 0);
    }
    if (!layer) return {};
    
    std::string actual_layer_name = OGR_L_GetName(layer);

    // Execute SQL query directly via SQLite dialect to force index usage
    std::string sql = "SELECT * FROM \"" + actual_layer_name + "\" WHERE GID_0 = '" + iso_code + "'";
    if (dot_count > 0 && dot_count <= level) {
        sql += " AND GID_" + std::to_string(dot_count) + " = '" + gadm_id + "'";
    }
    OGRLayerH query_layer = GDALDatasetExecuteSQL(ds, sql.c_str(), nullptr, "SQLite");
    
    if (!query_layer) {
        // Fallback to OGR filtering if ExecuteSQL fails
        std::string filter = "GID_0 = '" + iso_code + "'";
        if (dot_count > 0 && dot_count <= level) {
            filter += " AND GID_" + std::to_string(dot_count) + " = '" + gadm_id + "'";
        }
        OGR_L_SetAttributeFilter(layer, filter.c_str());
        query_layer = layer;
    }

    // Column names for this level
    std::string gid_col = "GID_" + std::to_string(level);
    std::string name_col = (level == 0) ? "COUNTRY" : ("NAME_" + std::to_string(level));

    std::vector<boundary::BoundaryFeature> result;

    OGRFeatureH feat;
    OGR_L_ResetReading(query_layer);
    while ((feat = OGR_L_GetNextFeature(query_layer)) != nullptr) {
        const char* gid_val = OGR_F_GetFieldAsString(feat, OGR_F_GetFieldIndex(feat, gid_col.c_str()));
        const char* name_val = OGR_F_GetFieldAsString(feat, OGR_F_GetFieldIndex(feat, name_col.c_str()));

        if (!gid_val || !name_val) {
            OGR_F_Destroy(feat);
            continue;
        }

        std::string code(gid_val);
        OGRGeometryH geom = OGR_F_GetGeometryRef(feat);

        boundary::BoundaryFeature bf;
        bf.code = code;
        bf.name = std::string(name_val);

        if (geom) {
            OGRGeometryH simplified = nullptr;
            if (tolerance > 0.0) {
                simplified = OGR_G_SimplifyPreserveTopology(geom, tolerance);
            }
            OGRGeometryH out_geom = simplified ? simplified : geom;

            OGREnvelope env;
            OGR_G_GetEnvelope(out_geom, &env);
            bf.minX = env.MinX;
            bf.maxX = env.MaxX;
            bf.minY = env.MinY;
            bf.maxY = env.MaxY;

            size_t wkbSize = OGR_G_WkbSize(out_geom);
            bf.wkb.resize(wkbSize);
            OGR_G_ExportToWkb(out_geom, wkbNDR, bf.wkb.data());

            char** papszOptions = CSLSetNameValue(nullptr, "COORDINATE_PRECISION", "5");
            char* json_str = OGR_G_ExportToJsonEx(out_geom, papszOptions);
            CSLDestroy(papszOptions);
            if (json_str) {
                bf.geojson = nlohmann::json::parse(json_str);
                CPLFree(json_str);
            }

            if (simplified) {
                OGR_G_DestroyGeometry(simplified);
            }
        }

        result.push_back(std::move(bf));
        OGR_F_Destroy(feat);
    }
    if (query_layer != layer) {
        GDALDatasetReleaseResultSet(ds, query_layer);
    }
    return result;
}

std::vector<GidName> query_unique_gids_in_bbox(
    const std::string& gpkg_path,
    double minx,
    double miny,
    double maxx,
    double maxy,
    int level,
    int cap
) {
    if (level < 0 || level > 5) return {};
    if (!(minx <= maxx && miny <= maxy)) return {};
    if (cap <= 0) cap = 300;

    std::lock_guard<std::mutex> lock(g_gpkg_mutex);
    ensure_open(gpkg_path);
    GDALDatasetH ds = g_ds;

    std::string layer_name = "ADM_ADM_" + std::to_string(level);
    OGRLayerH layer = GDALDatasetGetLayerByName(ds, layer_name.c_str());
    if (!layer) {
        layer = GDALDatasetGetLayer(ds, level);
        if (!layer) layer = GDALDatasetGetLayer(ds, 0);
    }
    if (!layer) return {};

    // Spatial filter on a clone-ish read cursor — SetSpatialFilterRect is layer-local.
    OGR_L_SetSpatialFilterRect(layer, minx, miny, maxx, maxy);
    OGR_L_SetAttributeFilter(layer, nullptr);
    OGR_L_ResetReading(layer);

    std::string gid_col = "GID_" + std::to_string(level);
    std::string name_col = (level == 0) ? "COUNTRY" : ("NAME_" + std::to_string(level));

    std::vector<GidName> out;
    out.reserve(static_cast<size_t>(std::min(cap, 64)));
    std::map<std::string, bool> seen;

    OGRFeatureH feat;
    while ((feat = OGR_L_GetNextFeature(layer)) != nullptr) {
        int gid_idx = OGR_F_GetFieldIndex(feat, gid_col.c_str());
        int name_idx = OGR_F_GetFieldIndex(feat, name_col.c_str());
        const char* gid_val = gid_idx >= 0 ? OGR_F_GetFieldAsString(feat, gid_idx) : nullptr;
        const char* name_val = name_idx >= 0 ? OGR_F_GetFieldAsString(feat, name_idx) : nullptr;
        OGR_F_Destroy(feat);

        if (!gid_val || !*gid_val) continue;
        std::string gid(gid_val);
        if (seen.count(gid)) continue;
        seen[gid] = true;
        out.push_back(GidName{gid, name_val && *name_val ? std::string(name_val) : gid});
        if (static_cast<int>(out.size()) >= cap) break;
    }

    OGR_L_SetSpatialFilter(layer, nullptr);
    return out;
}

static OGRLayerH resolve_admin_layer(GDALDatasetH ds, int level) {
    // Prefer per-level ADM layers when present; else flat gadm_410 / first layer.
    std::string layer_name = "ADM_ADM_" + std::to_string(level);
    OGRLayerH layer = GDALDatasetGetLayerByName(ds, layer_name.c_str());
    if (layer) return layer;
    layer = GDALDatasetGetLayerByName(ds, "gadm_410");
    if (layer) return layer;
    layer = GDALDatasetGetLayerByName(ds, "gadm41_raw");
    if (layer) return layer;
    layer = GDALDatasetGetLayer(ds, level);
    if (layer) return layer;
    return GDALDatasetGetLayer(ds, 0);
}

std::vector<HierarchyLevel> get_hierarchy_by_point(
    const std::string& gpkg_path,
    double lat,
    double lon
) {
    std::lock_guard<std::mutex> lock(g_gpkg_mutex);
    ensure_open(gpkg_path);
    GDALDatasetH ds = g_ds;

    OGRGeometryH pt = OGR_G_CreateGeometry(wkbPoint);
    if (!pt) return {};
    OGR_G_SetPoint_2D(pt, 0, lon, lat);

    // Prefer finest available ADM layer; flat gadm_410 works at any try_level.
    for (int try_level = 5; try_level >= 0; --try_level) {
        OGRLayerH layer = resolve_admin_layer(ds, try_level);
        if (!layer) continue;

        // ~1 km bbox so the spatial index returns candidates.
        const double eps = 0.01;
        OGR_L_SetSpatialFilterRect(layer, lon - eps, lat - eps, lon + eps, lat + eps);
        OGR_L_SetAttributeFilter(layer, nullptr);
        OGR_L_ResetReading(layer);

        OGRFeatureH feat;
        while ((feat = OGR_L_GetNextFeature(layer)) != nullptr) {
            OGRGeometryH geom = OGR_F_GetGeometryRef(feat);
            bool hit = false;
            if (geom) {
                hit = OGR_G_Contains(geom, pt) != 0 || OGR_G_Intersects(geom, pt) != 0;
            }
            if (!hit) {
                OGR_F_Destroy(feat);
                continue;
            }

            // Flat gadm_410 rows carry GID_0…GID_5 — always extract the full stack.
            std::vector<HierarchyLevel> results;
            for (int i = 0; i <= 5; ++i) {
                std::string gid_col = "GID_" + std::to_string(i);
                std::string name_col = "NAME_" + std::to_string(i);
                int gid_idx = OGR_F_GetFieldIndex(feat, gid_col.c_str());
                int name_idx = OGR_F_GetFieldIndex(feat, name_col.c_str());
                if (name_idx < 0 && i == 0) {
                    name_idx = OGR_F_GetFieldIndex(feat, "COUNTRY");
                }
                const char* gid_val = gid_idx >= 0 ? OGR_F_GetFieldAsString(feat, gid_idx) : nullptr;
                const char* name_val = name_idx >= 0 ? OGR_F_GetFieldAsString(feat, name_idx) : nullptr;
                if ((gid_val && *gid_val) || (name_val && *name_val)) {
                    HierarchyLevel hl;
                    hl.level = i;
                    hl.gid = gid_val ? gid_val : "";
                    hl.name = name_val ? name_val : "";
                    results.push_back(std::move(hl));
                }
            }
            OGR_F_Destroy(feat);
            OGR_L_SetSpatialFilter(layer, nullptr);
            OGR_G_DestroyGeometry(pt);
            return results;
        }

        OGR_L_SetSpatialFilter(layer, nullptr);
        // Flat table: one attempt is enough (same layer for every try_level).
        const char* lname = OGR_L_GetName(layer);
        if (lname && (std::string(lname) == "gadm_410" || std::string(lname) == "gadm41_raw")) {
            break;
        }
    }

    OGR_G_DestroyGeometry(pt);
    return {};
}

std::vector<std::map<std::string, std::string>> query_names(
    const std::string& gpkg_path,
    int content_level,
    const std::string& attr_filter,
    int limit
) {
    if (content_level < 0 || content_level > 5) return {};
    if (limit <= 0) limit = 50;

    std::lock_guard<std::mutex> lock(g_gpkg_mutex);
    ensure_open(gpkg_path);
    GDALDatasetH ds = g_ds;

    OGRLayerH layer = resolve_admin_layer(ds, content_level);
    if (!layer) return {};

    std::string name_col = "NAME_" + std::to_string(content_level);
    std::string gid_col = "GID_" + std::to_string(content_level);
    std::string lname = OGR_L_GetName(layer);

    // Attribute-only SQL — avoid OGR feature iteration (loads geom blobs = multi-second scans).
    std::ostringstream sql;
    sql << "SELECT DISTINCT \"" << name_col << "\", \"" << gid_col << "\" FROM \"" << lname << "\"";
    if (!attr_filter.empty()) {
        sql << " WHERE " << attr_filter;
    }
    sql << " LIMIT " << limit;

    OGRLayerH result = GDALDatasetExecuteSQL(ds, sql.str().c_str(), nullptr, "SQLite");
    if (!result) return {};

    std::vector<std::map<std::string, std::string>> out;
    OGRFeatureH feat;
    while ((feat = OGR_L_GetNextFeature(result)) != nullptr) {
        const char* name_val = OGR_F_GetFieldAsString(feat, 0);
        const char* gid_val = OGR_F_GetFieldAsString(feat, 1);
        OGR_F_Destroy(feat);
        if (!name_val || !*name_val) continue;
        out.push_back({
            {name_col, name_val},
            {gid_col, gid_val ? gid_val : ""},
        });
    }
    GDALDatasetReleaseResultSet(ds, result);
    return out;
}

} // namespace gpkg_reader
