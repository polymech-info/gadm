#include "ghs_enrich.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

// GDAL C API — handles any size GeoTIFF via windowed reads.
// The GHS TIFFs are ~3-8 GB global grids (100m Mollweide), but RasterIO
// only decompresses the bbox-clipped tile range, keeping memory bounded.
#include <cpl_conv.h>
#include <gdal.h>
#include <gdal_priv.h>

// PROJ C API — reusable transform handle, no per-pixel reinit.
#include <proj.h>

#include <geos_c.h>

namespace ghs_enrich {

// ── Constants ────────────────────────────────────────────────────────────────
static constexpr float NODATA_SENTINEL = 65535.f;
static constexpr double MIN_DIST_METERS =
    3000.0; // 3km separation between peaks
static constexpr int MAX_CENTERS = 5;

// ── Raster handle cache (opened once per process) ────────────────────────────
struct RasterInfo {
  GDALDatasetH ds = nullptr;
  GDALRasterBandH band = nullptr;
  double origin_x = 0; // top-left X in Mollweide meters
  double origin_y = 0; // top-left Y in Mollweide meters
  double res_x = 0;    // pixel width  (positive, ~100m)
  double res_y = 0;    // pixel height (negative, ~-100m)
  int width = 0;
  int height = 0;
};

static RasterInfo open_raster(const std::string &path) {
  GDALAllRegister();

  GDALDatasetH ds = GDALOpen(path.c_str(), GA_ReadOnly);
  if (!ds) {
    throw std::runtime_error("Cannot open raster: " + path);
  }

  double gt[6];
  GDALGetGeoTransform(ds, gt);

  RasterInfo ri;
  ri.ds = ds;
  ri.band = GDALGetRasterBand(ds, 1);
  ri.origin_x = gt[0]; // top-left X
  ri.origin_y = gt[3]; // top-left Y
  ri.res_x = gt[1];    // pixel width  (+100)
  ri.res_y = gt[5];    // pixel height (-100)
  ri.width = GDALGetRasterBandXSize(ri.band);
  ri.height = GDALGetRasterBandYSize(ri.band);
  return ri;
}

// ── Compute stats for one geometry against one raster ────────────────────────
struct RasterStats {
  double total = 0;
  double maxVal = 0;
  double centerLon = 0;
  double centerLat = 0;
  std::vector<std::array<double, 3>> centers;
  bool valid = false;
};

// ── Statistics calculation loop ─────────────────────────────────────────────
static RasterStats compute_stats(RasterInfo &ri, PJ *to_moll, PJ *to_wgs84,
                                 double minLon, double minLat, double maxLon,
                                 double maxLat,
                                 const GEOSPreparedGeometry *prep,
                                 GEOSContextHandle_t ctx, bool is_pop) {
  RasterStats stats;

  if (!prep) {
    return stats;
  }

  // ── Project WGS84 bbox → Mollweide ──────────────────────────────────────
  PJ_COORD sw = proj_coord(minLon, minLat, 0, 0);
  PJ_COORD ne = proj_coord(maxLon, maxLat, 0, 0);
  PJ_COORD sw_m = proj_trans(to_moll, PJ_FWD, sw);
  PJ_COORD ne_m = proj_trans(to_moll, PJ_FWD, ne);

  double mollMinX = std::min(sw_m.xy.x, ne_m.xy.x);
  double mollMaxX = std::max(sw_m.xy.x, ne_m.xy.x);
  double mollMinY = std::min(sw_m.xy.y, ne_m.xy.y);
  double mollMaxY = std::max(sw_m.xy.y, ne_m.xy.y);

  // ── Map to pixel coordinates ────────────────────────────────────────────
  // geo → pixel: px = (geo_x - origin_x) / res_x
  //              py = (geo_y - origin_y) / res_y   (res_y is negative)
  int py1 = static_cast<int>(std::floor((mollMinY - ri.origin_y) / ri.res_y));
  int py2 = static_cast<int>(std::floor((mollMaxY - ri.origin_y) / ri.res_y));
  int minPx = std::max(
      0, static_cast<int>(std::floor((mollMinX - ri.origin_x) / ri.res_x)));
  int maxPx = std::min(ri.width, static_cast<int>(std::ceil(
                                     (mollMaxX - ri.origin_x) / ri.res_x)));
  int minPy = std::max(0, std::min(py1, py2));
  int maxPy = std::min(ri.height, std::max(py1, py2));

  int widthPx = maxPx - minPx;
  int heightPx = maxPy - minPy;
  if (widthPx <= 0 || heightPx <= 0)
    return stats;

  // ── Read raster window ──────────────────────────────────────────────────
  // GDALRasterIO handles tiled/compressed TIFFs natively.
  // Only the tiles overlapping this window are decompressed — a 6 GB
  // global TIF won't be loaded into memory.
  std::vector<float> buf(static_cast<size_t>(widthPx) * heightPx);
  CPLErr err = GDALRasterIO(ri.band, GF_Read, minPx, minPy, widthPx, heightPx,
                            buf.data(), widthPx, heightPx, GDT_Float32, 0, 0);
  if (err != CE_None)
    return stats;

  // ── Pixel loop — accumulate stats ───────────────────────────────────────
  double totalVal = 0;
  double weightedX = 0;
  double weightedY = 0;
  double maxValFound = 0;

  // Candidate arrays for peak detection
  struct Candidate {
    double lon, lat;       // WGS84
    double moll_x, moll_y; // Mollweide (for distance calc)
    double val;
  };
  std::vector<Candidate> candidates;

  for (int y = 0; y < heightPx; ++y) {
    for (int x = 0; x < widthPx; ++x) {
      float val = buf[y * widthPx + x];

      if (val <= 0 || val == NODATA_SENTINEL || std::isnan(val))
        continue;

      // Pixel center → Mollweide coordinates
      double pxX = ri.origin_x + (minPx + x + 0.5) * ri.res_x;
      double pxY = ri.origin_y + (minPy + y + 0.5) * ri.res_y;

      // → WGS84 for PIP check
      PJ_COORD in = proj_coord(pxX, pxY, 0, 0);
      PJ_COORD out = proj_trans(to_wgs84, PJ_FWD, in);
      double ptLon = out.xy.x;
      double ptLat = out.xy.y;

      GEOSCoordSequence *seq = GEOSCoordSeq_create_r(ctx, 1, 2);
      GEOSCoordSeq_setXY_r(ctx, seq, 0, ptLon, ptLat);
      GEOSGeometry *pt = GEOSGeom_createPoint_r(ctx, seq);

      char inside = GEOSPreparedContains_r(ctx, prep, pt);
      GEOSGeom_destroy_r(ctx, pt);

      if (inside == 0)
        continue;

      totalVal += val;
      weightedX += (minPx + x) * static_cast<double>(val);
      weightedY += (minPy + y) * static_cast<double>(val);
      if (val > maxValFound)
        maxValFound = val;

      candidates.push_back({ptLon, ptLat, pxX, pxY, static_cast<double>(val)});
    }
  }

  if (totalVal <= 0)
    return stats;

  // ── Weighted center ─────────────────────────────────────────────────────
  double centerPx = weightedX / totalVal;
  double centerPy = weightedY / totalVal;
  double centerMollX = ri.origin_x + (centerPx + 0.5) * ri.res_x;
  double centerMollY = ri.origin_y + (centerPy + 0.5) * ri.res_y;
  PJ_COORD cc_in = proj_coord(centerMollX, centerMollY, 0, 0);
  PJ_COORD cc_out = proj_trans(to_wgs84, PJ_FWD, cc_in);

  stats.total = is_pop ? std::round(totalVal) : totalVal;
  stats.maxVal = is_pop ? std::round(maxValFound) : maxValFound;
  stats.centerLon = cc_out.xy.x;
  stats.centerLat = cc_out.xy.y;
  stats.valid = true;

  // ── Top-N peak detection with 3km separation ────────────────────────────
  std::sort(
      candidates.begin(), candidates.end(),
      [](const Candidate &a, const Candidate &b) { return a.val > b.val; });

  std::vector<size_t> selected;
  for (size_t i = 0; i < candidates.size() &&
                     static_cast<int>(stats.centers.size()) < MAX_CENTERS;
       ++i) {
    bool distinct = true;
    for (size_t si : selected) {
      double dx = candidates[i].moll_x - candidates[si].moll_x;
      double dy = candidates[i].moll_y - candidates[si].moll_y;
      if (std::hypot(dx, dy) < MIN_DIST_METERS) {
        distinct = false;
        break;
      }
    }
    if (distinct) {
      selected.push_back(i);
      double v = is_pop ? std::round(candidates[i].val) : candidates[i].val;
      stats.centers.push_back({candidates[i].lon, candidates[i].lat, v});
    }
  }

  return stats;
}

// ── GEOS context ────────────────────────────────────────────────────────────

static GEOSContextHandle_t get_geos_ctx() {
  static GEOSContextHandle_t ctx = GEOS_init_r();
  return ctx;
}

// ── Public API ──────────────────────────────────────────────────────────────

EnrichResult enrich_feature(const std::vector<unsigned char> &wkb,
                            double minLon, double minLat, double maxLon,
                            double maxLat, const std::string &pop_tiff_path,
                            const std::string &built_tiff_path) {
  EnrichResult result;

  // ── PROJ transforms (created once, reused per-pixel) ────────────────────
  // EPSG:54009 is not a real EPSG code — use the Mollweide proj-string
  static const char *MOLL_WKT =
      "+proj=moll +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs";
  PJ_CONTEXT *ctx = proj_context_create();

  // proj_create_crs_to_crs uses EPSG:4326's native axis order (lat,lon).
  // proj_normalize_for_visualization forces lon,lat which our code expects.
  PJ *to_moll_raw = proj_create_crs_to_crs(ctx, "EPSG:4326", MOLL_WKT, nullptr);
  PJ *to_moll = to_moll_raw ? proj_normalize_for_visualization(ctx, to_moll_raw)
                            : nullptr;
  if (to_moll_raw)
    proj_destroy(to_moll_raw);

  PJ *to_wgs84_raw =
      proj_create_crs_to_crs(ctx, MOLL_WKT, "EPSG:4326", nullptr);
  PJ *to_wgs84 = to_wgs84_raw
                     ? proj_normalize_for_visualization(ctx, to_wgs84_raw)
                     : nullptr;
  if (to_wgs84_raw)
    proj_destroy(to_wgs84_raw);

  if (!to_moll || !to_wgs84) {
    if (to_moll)
      proj_destroy(to_moll);
    if (to_wgs84)
      proj_destroy(to_wgs84);
    proj_context_destroy(ctx);
    throw std::runtime_error("Failed to create PROJ transforms");
  }

  if (wkb.empty())
    return result;

  GEOSContextHandle_t geos_ctx = get_geos_ctx();
  GEOSWKBReader *reader = GEOSWKBReader_create_r(geos_ctx);
  GEOSGeometry *geom =
      GEOSWKBReader_read_r(geos_ctx, reader, wkb.data(), wkb.size());
  GEOSWKBReader_destroy_r(geos_ctx, reader);

  if (!geom) {
    proj_destroy(to_moll);
    proj_destroy(to_wgs84);
    proj_context_destroy(ctx);
    return result;
  }

  const GEOSPreparedGeometry *prep = GEOSPrepare_r(geos_ctx, geom);

  // ── Population raster ───────────────────────────────────────────────────
  if (!pop_tiff_path.empty()) {
    static RasterInfo pop_ri;
    static bool pop_opened = false;
    if (!pop_opened) {
      pop_ri = open_raster(pop_tiff_path);
      pop_opened = true;
    }

    auto pop_stats = compute_stats(pop_ri, to_moll, to_wgs84, minLon, minLat,
                                   maxLon, maxLat, prep, geos_ctx, true);
    if (pop_stats.valid) {
      result.hasPop = true;
      result.ghsPopulation = pop_stats.total;
      result.ghsPopMaxDensity = pop_stats.maxVal;
      result.ghsPopCenterLon = pop_stats.centerLon;
      result.ghsPopCenterLat = pop_stats.centerLat;
      result.ghsPopCenters = pop_stats.centers;
    }
  }

  // ── Built-up surface raster ─────────────────────────────────────────────
  if (!built_tiff_path.empty()) {
    static RasterInfo built_ri;
    static bool built_opened = false;
    if (!built_opened) {
      built_ri = open_raster(built_tiff_path);
      built_opened = true;
    }

    auto built_stats =
        compute_stats(built_ri, to_moll, to_wgs84, minLon, minLat, maxLon,
                      maxLat, prep, geos_ctx, false);
    if (built_stats.valid) {
      result.hasBuilt = true;
      result.ghsBuiltWeight = built_stats.total;
      result.ghsBuiltMax = built_stats.maxVal;
      result.ghsBuiltCenterLon = built_stats.centerLon;
      result.ghsBuiltCenterLat = built_stats.centerLat;
      result.ghsBuiltCenters = built_stats.centers;
    }
  }

  GEOSPreparedGeom_destroy_r(geos_ctx, prep);
  GEOSGeom_destroy_r(geos_ctx, geom);

  proj_destroy(to_moll);
  proj_destroy(to_wgs84);
  proj_context_destroy(ctx);

  return result;
}

std::vector<EnrichResult>
enrich_batch(const std::vector<std::vector<unsigned char>> &wkbs,
             const std::string &pop_tiff_path,
             const std::string &built_tiff_path) {
  std::vector<EnrichResult> results;
  //  results.reserve(wkbs.size());
  //  for (const auto &wkb : wkbs) {
  //    results.push_back(enrich_feature(wkb, 0, 0, 0, 0, pop_tiff_path,
  //    built_tiff_path));
  //  }
  return results;
}

} // namespace ghs_enrich
