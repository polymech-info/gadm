#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include <CLI/CLI.hpp>
#include <nlohmann/json.hpp>

#include "geo_display.h"
#include "geo_merge.h"
#include "ghs_enrich.h"
#include "gpkg_reader.h"
#include "logger/logger.h"
#include "types.h"

namespace fs = std::filesystem;
using json = nlohmann::json;

#ifndef PROJECT_VERSION
#define PROJECT_VERSION "1.0.0"
#endif

static bool file_exists(const fs::path &p) {
  return fs::exists(p) && fs::file_size(p) > 0;
}

static double round5(double val) {
  return std::round(val * 100000.0) / 100000.0;
}

int main(int argc, char *argv[]) {
  CLI::App app{"gadm-boundaries — GADM Boundaries Batch Generator",
               "boundaries"};
  app.set_version_flag("-v,--version", PROJECT_VERSION);

  std::string country = "all";
  int level = -1; // -1 = all levels
  std::string cache_dir = "cache/gadm";
  std::string gpkg_path = "data/gadm_410-levels.gpkg";
  std::string continent_json = "data/gadm_continent.json";
  std::string pop_tiff =
      "data/ghs/GHS_POP_E2030_GLOBE_R2023A_54009_100_V1_0.tif";
  std::string built_tiff =
      "data/ghs/GHS_BUILT_S_E2030_GLOBE_R2023A_54009_100_V1_0.tif";
  bool force = false;
  bool display_clean = false;
  double min_outer_km = 5.0;
  int resolution = 3; // Default matching CLI and TS wrapper
  std::vector<int> split_levels = {0};

  app.add_option("--country", country, "ISO3 country code, or 'all' for batch")
      ->default_val("all");
  app.add_option("--level", level, "Admin level (0-5), or -1 for all levels")
      ->default_val(-1);
  app.add_option("--cache-dir", cache_dir,
                 "Output directory for boundary JSON files")
      ->default_val("cache/gadm");
  app.add_option("--gpkg", gpkg_path, "Path to GADM GeoPackage file")
      ->default_val("data/gadm_410.gpkg");
  app.add_option("--continent-json", continent_json,
                 "Path to gadm_continent.json")
      ->default_val("data/gadm_continent.json");
  app.add_option("--pop-tiff", pop_tiff, "Path to GHS-POP GeoTIFF")
      ->default_val("data/ghs/GHS_POP_E2030_GLOBE_R2023A_54009_100_V1_0.tif");
  app.add_option("--built-tiff", built_tiff, "Path to GHS-BUILT-S GeoTIFF")
      ->default_val(
          "data/ghs/GHS_BUILT_S_E2030_GLOBE_R2023A_54009_100_V1_0.tif");
  app.add_flag("--force", force, "Regenerate even if cache file exists");
  app.add_flag("--display-clean", display_clean,
               "Strip lake holes, drop outer islands <min-outer-km, coast smooth "
               "(map-paint cache; matches TS prepareBoundaryForMap)");
  app.add_option("--min-outer-km", min_outer_km,
                 "With --display-clean: min outer-island bbox width (km)")
      ->default_val(5.0);
  app.add_option("--resolution", resolution,
                 "Simplification resolution (1=full to 10=max simplification)")
      ->default_val(3);
  app.add_option("--split-levels", split_levels,
                 "Comma-separated levels to split output files (e.g. 1,2,3)")
      ->default_val(std::vector<int>{0})
      ->delimiter(',');

  CLI11_PARSE(app, argc, argv);

  // Always ensure split_levels includes 0 (country-wide output file).
  // User-provided --split-levels=1,2,3 means "also split into sub-regions",
  // but the country-level file (boundary_ESP_1.json) must always be generated.
  if (std::find(split_levels.begin(), split_levels.end(), 0) ==
      split_levels.end()) {
    split_levels.insert(split_levels.begin(), 0);
  }

  // Set PROJ_DATA so PROJ can find proj.db next to the exe
  {
    auto exe_dir = fs::path(argv[0]).parent_path();
    auto proj_db_local = exe_dir / "proj.db";
    auto proj_share = exe_dir / "share" / "proj";
    if (fs::exists(proj_db_local)) {
#ifdef _WIN32
      _putenv_s("PROJ_DATA", exe_dir.string().c_str());
#else
      setenv("PROJ_DATA", exe_dir.string().c_str(), 1);
#endif
    } else if (fs::exists(proj_share / "proj.db")) {
#ifdef _WIN32
      _putenv_s("PROJ_DATA", proj_share.string().c_str());
#else
      setenv("PROJ_DATA", proj_share.string().c_str(), 1);
#endif
    }
  }

  logger::init("boundaries");

  // ── Load continent mapping ──────────────────────────────────────────────
  json continent_map;
  {
    std::ifstream f(continent_json);
    if (!f.is_open()) {
      logger::error("Cannot open continent file: " + continent_json);
      return 1;
    }
    f >> continent_map;
  }

  // ── Resolve country list ────────────────────────────────────────────────
  std::vector<std::string> countries;
  if (country == "all") {
    // continent_map is { "europe": ["DEU","FRA",...], "asia": [...], ... }
    for (auto &[continent, codes] : continent_map.items()) {
      if (codes.is_array()) {
        for (const auto &c : codes) {
          countries.push_back(c.get<std::string>());
        }
      }
    }
    std::sort(countries.begin(), countries.end());
  } else {
    countries.push_back(country);
  }

  // ── Resolve levels ──────────────────────────────────────────────────────
  std::vector<int> levels;
  if (level < 0) {
    levels = {0, 1, 2, 3, 4, 5};
  } else {
    levels = {level};
  }

  // ── Calculate simplification tolerance ────────────────────────────────────
  double tolerance = 0.0;
  switch (resolution) {
  case 1:
    tolerance = 0.0;
    break;
  case 2:
    tolerance = 0.001;
    break; // ~100m
  case 3:
    tolerance = 0.002;
    break; // ~200m
  case 4:
    tolerance = 0.005;
    break; // ~500m
  case 5:
    tolerance = 0.01;
    break; // ~1km
  case 6:
    tolerance = 0.02;
    break; // ~2km
  case 7:
    tolerance = 0.05;
    break; // ~5km
  case 8:
    tolerance = 0.1;
    break; // ~10km
  case 9:
    tolerance = 0.2;
    break; // ~20km
  case 10:
    tolerance = 0.5;
    break; // ~50km
  default:
    if (resolution > 10)
      tolerance = 0.5;
    break;
  }

  // ── Ensure cache directory exists ───────────────────────────────────────
  fs::create_directories(cache_dir);

  logger::info("Processing " + std::to_string(countries.size()) +
               " countries x " + std::to_string(levels.size()) + " levels");

  // ── Main loop ───────────────────────────────────────────────────────────
  int processed = 0;
  int skipped = 0;
  int errors = 0;

  // Note: OpenMP disabled — GDAL/PROJ/GEOS are not thread-safe for concurrent
  //       GeoTIFF reads + PROJ transform creation + geometry unions.
  //       Sequential execution is fast enough (I/O-bound).
  for (int i = 0; i < static_cast<int>(countries.size()); ++i) {
    const auto &code = countries[i];

    for (int lvl : levels) {
      for (int split_lvl : split_levels) {
        if (split_lvl > lvl)
          continue;

        std::vector<std::string> regions;
        if (split_lvl == 0) {
          regions.push_back(code);
        } else {
          regions = gpkg_reader::get_subregions(gpkg_path, code, split_lvl);
        }

        for (const auto &region_id : regions) {
          std::string filename =
              "boundary_" + region_id + "_" + std::to_string(lvl) + ".json";
          fs::path country_dir = fs::path(cache_dir) / code;
          fs::create_directories(country_dir);
          fs::path out_path = country_dir / filename;

          // Skip if cached
          if (!force && file_exists(out_path)) {
            ++skipped;
            continue;
          }

          try {
            // 1. Read features from GeoPackage
            auto t0 = std::chrono::high_resolution_clock::now();
            auto features = gpkg_reader::read_features(gpkg_path, region_id,
                                                       lvl, tolerance);
            auto t1 = std::chrono::high_resolution_clock::now();
            if (features.empty()) {
              ++skipped;
              continue;
            }

            // 2. Merge geometries
            auto merged = geo_merge::merge(features);
            auto t2 = std::chrono::high_resolution_clock::now();

            // 3. Write output JSON
            json output = json::object();
            output["type"] = "FeatureCollection";
            output["features"] = json::array();

            bool has_pop = file_exists(pop_tiff);
            bool has_built = file_exists(built_tiff);

            for (const auto &feat : merged) {
              json j = json::object();
              j["type"] = "Feature";

              json props = json::object();
              props["NAME_" + std::to_string(lvl)] = feat.name;
              props["GID_" + std::to_string(lvl)] = feat.code;

              int dotCount = static_cast<int>(
                  std::count(feat.code.begin(), feat.code.end(), '.'));
              if (lvl == dotCount) {
                props["isOuter"] = true;
              }

              // 4. Enrich with GHS raster data
              if (has_pop || has_built) {
                try {
                  auto er = ghs_enrich::enrich_feature(
                      feat.wkb, feat.minX, feat.minY, feat.maxX, feat.maxY,
                      pop_tiff, built_tiff);
                  if (er.hasPop) {
                    props["ghsPopulation"] = std::round(
                        er.ghsPopulation); // Ensure no .0 trailing decimals
                    props["ghsPopMaxDensity"] =
                        std::round(er.ghsPopMaxDensity * 10.0) / 10.0;
                    props["ghsPopCenter"] = {round5(er.ghsPopCenterLon),
                                             round5(er.ghsPopCenterLat)};
                    json centers = json::array();
                    for (const auto &c : er.ghsPopCenters)
                      centers.push_back(
                          {round5(c[0]), round5(c[1]), std::round(c[2])});
                    props["ghsPopCenters"] = centers;
                  }
                  if (er.hasBuilt) {
                    props["ghsBuiltWeight"] =
                        std::round(er.ghsBuiltWeight * 10.0) / 10.0;
                    props["ghsBuiltMax"] =
                        std::round(er.ghsBuiltMax * 10.0) / 10.0;
                    props["ghsBuiltCenter"] = {round5(er.ghsBuiltCenterLon),
                                               round5(er.ghsBuiltCenterLat)};
                    json bcenters = json::array();
                    for (const auto &c : er.ghsBuiltCenters)
                      bcenters.push_back({round5(c[0]), round5(c[1]),
                                          std::round(c[2] * 10.0) / 10.0});
                    props["ghsBuiltCenters"] = bcenters;
                  }
                } catch (const std::exception &ex) {
                  logger::warn(feat.code + " enrich failed: " + ex.what());
                }
              }

              j["properties"] = props;
              j["geometry"] = feat.geojson;
              output["features"].push_back(j);
            }

            if (display_clean) {
              geo_display::Options dopts;
              dopts.minOuterWidthKm = min_outer_km;
              geo_display::clean_feature_collection(output, dopts);
            }

            auto t3 = std::chrono::high_resolution_clock::now();
            std::ofstream ofs(out_path);
            ofs << output.dump();
            ofs.close();
            auto t4 = std::chrono::high_resolution_clock::now();

            ++processed;

            auto ms_read =
                std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0)
                    .count();
            auto ms_merge =
                std::chrono::duration_cast<std::chrono::milliseconds>(t2 - t1)
                    .count();
            auto ms_enrich =
                std::chrono::duration_cast<std::chrono::milliseconds>(t3 - t2)
                    .count();
            auto ms_write =
                std::chrono::duration_cast<std::chrono::milliseconds>(t4 - t3)
                    .count();
            auto ms_total =
                std::chrono::duration_cast<std::chrono::milliseconds>(t4 - t0)
                    .count();

            logger::info("[" + std::to_string(processed) + "] " + code + " L" +
                         std::to_string(lvl) + " (" +
                         std::to_string(merged.size()) + " features) " +
                         "| read:" + std::to_string(ms_read) + "ms " +
                         "merge:" + std::to_string(ms_merge) + "ms " +
                         "enrich:" + std::to_string(ms_enrich) + "ms " +
                         "write:" + std::to_string(ms_write) + "ms " +
                         "Total:" + std::to_string(ms_total) + "ms");

          } catch (const std::exception &e) {
            ++errors;
            logger::error(region_id + " L" + std::to_string(lvl) + ": " +
                          e.what());
          }
        }
      }
    }
  }

  logger::info("Done. processed=" + std::to_string(processed) + " skipped=" +
               std::to_string(skipped) + " errors=" + std::to_string(errors));

  return errors > 0 ? 1 : 0;
}
