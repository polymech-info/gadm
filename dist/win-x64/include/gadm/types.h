#pragma once

#include <string>
#include <vector>
#include <nlohmann/json.hpp>

namespace boundary {

/// A single administrative boundary feature (one GID code).
struct BoundaryFeature {
    std::string code;        // e.g. "DEU.1_1" (GID_{level})
    std::string name;        // e.g. "Bayern"
    nlohmann::json geojson;  // GeoJSON geometry object
    std::vector<unsigned char> wkb;

    double minX = 0, minY = 0, maxX = 0, maxY = 0;

    // Raw GEOS geometry handle (opaque, managed by caller)
    void* geos_geom = nullptr;
};

/// Result of a full boundary batch for one country+level.
struct BoundaryResult {
    std::string country;
    int level = 0;
    int featureCount = 0;
    std::vector<BoundaryFeature> features;
};

} // namespace boundary
