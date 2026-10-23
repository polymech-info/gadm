#pragma once

#include <map>
#include <string>
#include <vector>
#include "types.h"

namespace gpkg_reader {

struct GidName {
    std::string gid;
    std::string name;
};

/// Read features from a GeoPackage file, filtered by country (GID_0) and admin level.
/// Groups features by GID_{level} and returns one BoundaryFeature per group
/// with its geometry as a GEOS handle.
/// Retrieve a list of distinct GID_{split_level} values for a given country code
std::vector<std::string> get_subregions(
    const std::string& gpkg_path,
    const std::string& country_code,
    int split_level
);

/// Read features from a GeoPackage file, filtered by country (GID_0) and admin level.
/// Can also filter directly by sub-region if country_code is a dotted GADM ID (e.g. ESP.6_1).
std::vector<boundary::BoundaryFeature> read_features(
    const std::string& gpkg_path,
    const std::string& country_code,
    int level,
    double tolerance = 0.0
);

/**
 * Distinct GID/NAME at admin `level` whose geometries intersect bbox
 * [minx, miny, maxx, maxy] (WGS84). Uses OGR spatial filter on ADM_ADM_{level}.
 */
std::vector<GidName> query_unique_gids_in_bbox(
    const std::string& gpkg_path,
    double minx,
    double miny,
    double maxx,
    double maxy,
    int level,
    int cap = 300
);

struct HierarchyLevel {
    int level = 0;
    std::string gid;
    std::string name; // gadmName
};

/**
 * Point-in-polygon hierarchy (L0…Ln) at (lon, lat) WGS84.
 * Uses finest available ADM_ADM_* layer with OGR Contains.
 */
std::vector<HierarchyLevel> get_hierarchy_by_point(
    const std::string& gpkg_path,
    double lat,
    double lon
);

/**
 * Distinct NAME/GID rows at `content_level` matching attribute filter
 * (OGR SetAttributeFilter dialect). Cap with `limit`.
 */
std::vector<std::map<std::string, std::string>> query_names(
    const std::string& gpkg_path,
    int content_level,
    const std::string& attr_filter,
    int limit = 50
);

} // namespace gpkg_reader
