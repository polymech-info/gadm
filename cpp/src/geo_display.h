#pragma once

#include <nlohmann/json.hpp>

namespace geo_display {

struct Options {
    /// Drop MultiPolygon outer parts whose bbox min width is below this (km).
    /// Largest part is always kept. 0 disables.
    double minOuterWidthKm = 5.0;
    bool keepHoles = false;
    bool skipCoastSmooth = false;
    // Coast smooth defaults — match packages/gadm/src/simplify-map.ts
    double maxTipDeg = 42.0;
    double maxLegFrac = 0.04;
    double minLegDeg = 0.002;
    double minDetour = 1.12;
    double maxEarAreaFrac = 2.5e-5;
    int maxPasses = 8;
};

/**
 * In-place display cleanup on a GeoJSON geometry object (Polygon / MultiPolygon /
 * GeometryCollection): strip interiors, drop small outer islands, coast spike/ear filter.
 * Returns false if the geometry becomes empty.
 */
bool clean_geometry(nlohmann::json &geometry, const Options &opts = {});

/**
 * Clean every feature geometry in a FeatureCollection. Stamps `_mapPaint: true`
 * on the collection when at least one feature remains.
 */
void clean_feature_collection(nlohmann::json &fc, const Options &opts = {});

} // namespace geo_display
