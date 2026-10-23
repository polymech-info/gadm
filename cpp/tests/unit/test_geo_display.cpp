#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include "geo_display.h"

using json = nlohmann::json;

TEST_CASE("drop small outer islands and stamp _mapPaint", "[geo_display]") {
  json fc = json::parse(R"({
    "type": "FeatureCollection",
    "features": [{
      "type": "Feature",
      "properties": {},
      "geometry": {
        "type": "MultiPolygon",
        "coordinates": [
          [[[0,0],[1,0],[1,1],[0,1],[0,0]]],
          [[[2,0.0],[2.01,0.0],[2.01,0.01],[2,0.01],[2,0.0]]]
        ]
      }
    }]
  })");

  geo_display::Options opts;
  opts.minOuterWidthKm = 5.0;
  opts.skipCoastSmooth = true;
  geo_display::clean_feature_collection(fc, opts);

  REQUIRE(fc.contains("_mapPaint"));
  REQUIRE(fc["_mapPaint"] == true);
  REQUIRE(fc["features"].size() == 1);
  REQUIRE(fc["features"][0]["geometry"]["type"] == "Polygon");
}

TEST_CASE("strip interior rings", "[geo_display]") {
  json withHole = json::parse(R"({
    "type": "Polygon",
    "coordinates": [
      [[0,0],[2,0],[2,2],[0,2],[0,0]],
      [[0.5,0.5],[1.5,0.5],[1.5,1.5],[0.5,1.5],[0.5,0.5]]
    ]
  })");

  geo_display::Options opts;
  opts.skipCoastSmooth = true;
  REQUIRE(geo_display::clean_geometry(withHole, opts));
  REQUIRE(withHole["coordinates"].size() == 1);
}
