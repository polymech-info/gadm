#pragma once

#include <string>
#include <vector>
#include <nlohmann/json.hpp>

namespace ghs_enrich {

/// Enrichment results for a single boundary feature.
struct EnrichResult {
    // Population grid (GHS-POP)
    double ghsPopulation   = 0;
    double ghsPopMaxDensity = 0;
    double ghsPopCenterLon = 0;
    double ghsPopCenterLat = 0;
    std::vector<std::array<double, 3>> ghsPopCenters;  // [lon, lat, density]

    // Built-up surface (GHS-BUILT-S)
    double ghsBuiltWeight  = 0;
    double ghsBuiltMax     = 0;
    double ghsBuiltCenterLon = 0;
    double ghsBuiltCenterLat = 0;
    std::vector<std::array<double, 3>> ghsBuiltCenters; // [lon, lat, built]

    bool hasPop   = false;
    bool hasBuilt = false;
};

/// Enrich a GeoJSON feature geometry with GHS raster statistics.
///
/// The TIFFs are global grids in Mollweide (EPSG:54009) at 100m resolution:
///   - GHS_POP_E2030_GLOBE_R2023A_54009_100_V1_0.tif  (~3–8 GB)
///   - GHS_BUILT_S_E2030_GLOBE_R2023A_54009_100_V1_0.tif
///
/// GDAL reads these via windowed RasterIO — only the bbox-clipped
/// portion is loaded, so memory use stays bounded regardless of file size.
EnrichResult enrich_feature(
    const std::vector<unsigned char> &wkb,
    double minLon, double minLat, double maxLon, double maxLat,
    const std::string &pop_tiff_path = "",
    const std::string &built_tiff_path = "");

/// Convenience: enrich all features in a batch, returning enrichment data
/// indexed by feature position.
std::vector<EnrichResult> enrich_batch(
    const std::vector<std::vector<unsigned char>> &wkbs,
    const std::string &pop_tiff_path = "",
    const std::string &built_tiff_path = "");

} // namespace ghs_enrich
