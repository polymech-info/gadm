#include "gpkg_reader.h"

#include <stdexcept>
#include <map>
#include <nlohmann/json.hpp>

// GDAL/OGR C API
#include <gdal.h>
#include <ogr_api.h>
#include <cpl_conv.h>
#include <cpl_string.h>

namespace gpkg_reader {

static GDALDatasetH g_ds = nullptr;
static std::string g_current_gpkg = "";

static void ensure_open(const std::string& gpkg_path) {
    if (!g_ds || g_current_gpkg != gpkg_path) {
        if (g_ds) GDALClose(g_ds);
        GDALAllRegister();
        // Try opening in update mode to create indices
        g_ds = GDALOpenEx(
            gpkg_path.c_str(), GDAL_OF_VECTOR | GDAL_OF_UPDATE,
            nullptr, nullptr, nullptr
        );
        if (g_ds) {
            // Build indices to make reads instantaneous
            for (int i = 0; i < GDALDatasetGetLayerCount(g_ds); ++i) {
                OGRLayerH l = GDALDatasetGetLayer(g_ds, i);
                if (l) {
                    std::string lname = OGR_L_GetName(l);
                    std::string sql = "CREATE INDEX IF NOT EXISTS idx_" + lname + "_gid0 ON \"" + lname + "\" (GID_0)";
                    OGRLayerH res = GDALDatasetExecuteSQL(g_ds, sql.c_str(), nullptr, "SQLite");
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
    return result;
}

} // namespace gpkg_reader
