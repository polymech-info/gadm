#pragma once

#include <string>
#include <vector>
#include "types.h"

namespace gpkg_reader {

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

} // namespace gpkg_reader
