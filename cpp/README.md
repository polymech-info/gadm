# gadm-boundaries (C++)

Native C++ boundaries batch generator for the GADM pipeline.  
Uses GDAL/GEOS/PROJ for geometry union + GHS raster enrichment (population & built-up surface), plus an optional **map-paint display clean** pass shared with the TypeScript `prepareBoundaryForMap` pipeline.

## Prerequisites

| Tool | Version |
|------|---------|
| CMake | >= 3.20 |
| C++ compiler | C++20 (MSVC, GCC, or Clang) |
| Ninja | On `PATH` (Windows release preset) |
| vcpkg | Toolchain file; see build section |

vcpkg dependencies (via `vcpkg.json`): GDAL, GEOS, PROJ, nlohmann-json. CLI11 / Catch2 / spdlog are pulled via CMake FetchContent.

## Build

### Windows (MSVC + Ninja)

Uses the same VS-env injection pattern as pixlwiz (`cpp/scripts/vs-env.mjs` + `cmake.mjs` / `ninja.mjs`).  
`ensure-vcpkg.mjs` restores `VCPKG_ROOT` if the env path is stale (clones `cpp/.vcpkg` and reuses `./vcpkg_installed`).

```bash
cd packages/gadm
npm run configure:cpp      # cmake --preset release (injects cl.exe + VCPKG_ROOT)
npm run build:cpp          # configure + ninja boundaries
npm run build:cpp:fast     # ninja only (after configure)
npm run build:cpp:tests    # ninja test_geo_display
```

| Preset | Notes |
|--------|--------|
| `release` (default) | Ninja + `VCPKG_MANIFEST_INSTALL=OFF` + `VCPKG_INSTALLED_DIR=./vcpkg_installed` — **fast**, reuses baked packages |
| `release-fresh` | Runs `vcpkg install` (rebuilds GDAL etc. — slow) |
| `dev` | Debug build under `build/dev` |

Output: `dist/win-x64/boundaries.exe` + runtime DLLs + `proj.db`

### Linux (Ubuntu)

```bash
sudo apt install cmake ninja-build pkg-config g++ git curl zip unzip tar
git clone https://github.com/microsoft/vcpkg.git ~/vcpkg && ~/vcpkg/bootstrap-vcpkg.sh
export VCPKG_ROOT=~/vcpkg

cd packages/gadm/cpp
cmake --preset vcpkg-linux
cmake --build build --config Release
```

## HTTP serve (geom off Node)

Thin **cpp-httplib** shell linking `gadm_boundaries_static` — file-serves map JSON and small spatial queries. Bind loopback; Node configures via `server/.env` (`GADM_HTTP_URL`, `GADM_HTTP_ENABLED`, timeouts) and streams with Hono `proxy`.

```bash
# Windows
npm run boundaries:cpp:serve
# Linux
npm run boundaries:cpp:linux:serve

# Stress (llm-server style ramp)
npm run stress:gadm-http -- --base http://127.0.0.1:3340 --levels 1,5,10,25
```

| Route | Notes |
|-------|--------|
| `GET /health` | liveness |
| `GET /v1/regions/boundary/{gid}?level=&map=1` | cache file bytes (no Node parse) |
| `GET /v1/regions/in-viewport?...` | OGR bbox → `{data:[{gid,gadmName,level}]}` |
| `GET /v1/regions/neighbors?gid=&level=` | file cache `neighbors_v6_*` or GEOS distance compute |
| `GET /v1/regions/hierarchy?lat=&lon=` | PIP stack L0…Ln `{data:[{level,gid,gadmName}]}` |
| `GET /v1/regions/search?query=&content_level=&country=` | name/GID metadata rows from gpkg |
| `GET /v1/regions/names?admin=&content_level=&depth=` | child NAME/GID rows under admin |
| `GET /cache/...` | static mount of `--cache-dir` |

Gridsearch list/summary REST lives on the **polymech-cli worker** (`--uds` + `--http`), not here:
`GET /v1/places/gridsearch/summary?userId=` (slim PG list). Node uses `GRIDSEARCH_HTTP_URL` or the co-hosted port (`udsPort+10000`).

Lib consumers: `#include` headers under `dist/*/include/gadm`, link `gadm_boundaries_static` / shared.
Output: `dist/linux-x64/boundaries` + `proj.db`

> **Note:** First **fresh** vcpkg install takes 10–20 min (GDAL/GEOS/PROJ). With an existing `vcpkg_installed/` tree, `release` configure is seconds.

## Usage

```bash
# From the gadm package root (not cpp/)
# Ensure DLLs are discoverable (dist/win-x64 or vcpkg_installed/.../bin on PATH)

# All countries, all levels (263 countries x 6 levels)
.\dist\win-x64\boundaries.exe --country=all

# Single country + level
.\dist\win-x64\boundaries.exe --country=DEU --level=0

# Map-paint L0 for all countries (holes + islands <5 km + coast smooth)
.\dist\win-x64\boundaries.exe --country=all --level=0 --display-clean --min-outer-km=5 --force `
  --cache-dir=cache/gadm --gpkg=data/gadm_410.gpkg `
  --pop-tiff=__none__.tif --built-tiff=__none__.tif --resolution=3

# Sub-region batch
.\dist\win-x64\boundaries.exe --country=all --level=4 --split-levels=1

# Force regeneration
.\dist\win-x64\boundaries.exe --country=NGA --force
```

### CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--country` | `all` | ISO3 code, dotted GADM ID (e.g. `ESP.6_1`), or `all` |
| `--level` | `-1` | Admin level 0–5, or -1 for all |
| `--split-levels` | `0` | Levels to also emit per-subregion files (e.g. `0,1`) |
| `--resolution` | `3` | Simplify resolution (1=full … 10=max); see package readme |
| `--display-clean` | off | Strip lake holes, drop outer islands &lt; `--min-outer-km`, coast spike/ear smooth; stamps `_mapPaint` |
| `--min-outer-km` | `5` | With `--display-clean`: min outer-island bbox width (km); largest part always kept |
| `--cache-dir` | `cache/gadm` | Output directory |
| `--gpkg` | `data/gadm_410.gpkg` | GADM GeoPackage |
| `--continent-json` | `data/gadm_continent.json` | Continent → ISO3 map |
| `--pop-tiff` / `--built-tiff` | GHS paths under `data/ghs/` | Pass a nonexistent path (e.g. `__none__.tif`) to skip enrich |
| `--force` | off | Regenerate even if cache file exists |

#### `--display-clean` (map paint)

Matches TypeScript `prepareBoundaryForMap` in `src/simplify-map.ts`:

1. Drop interior rings (lakes)  
2. Drop MultiPolygon outer parts whose bbox **min side** &lt; `--min-outer-km` (keep largest by area)  
3. Smooth coastline V-spikes / harbour ears (short legs only; fjords preserved)  
4. Set FeatureCollection `_mapPaint: true`

Use this for MapLibre hover/selection outlines. Prefer skipping GHS when regenerating display-only L0 (see note below).

#### GHS enrich / Antarctica

Enrich samples GHS-POP / GHS-BUILT GeoTIFFs when those files exist. **Antarctica (`ATA`) can access-violate during enrich** on the current GDAL path. For geometry-only regenerations:

```bash
--pop-tiff=__none__.tif --built-tiff=__none__.tif
```

#### `--split-levels`

By default (`--split-levels=0`), one file per country per level: `boundary_ESP_4.json`.

With `--split-levels=1`, also emits per L1 region files like `boundary_ESP.6_1_4.json`. The TS wrapper discovers sub-region files before falling back to the country file.

### npm Scripts

```bash
npm run configure:cpp
npm run build:cpp
npm run build:cpp:fast
npm run boundaries:cpp                    # runs dist exe --country=all
npm run boundaries:cpp:all:display        # all countries + --display-clean (see package.json)
```

On Linux, run the binary under `dist/linux-x64/` directly.

## Output

Files under `cache/gadm/{ISO3}/`:

- `boundary_{CODE}_{LEVEL}.json` — country file (e.g. `boundary_ESP_0.json`)
- `boundary_{GADM_ID}_{LEVEL}.json` — sub-region file when `--split-levels` is used

Cache resolution order (TS `gpkg-reader`):

1. Exact sub-region file  
2. Full country file (prefix-filtered)  
3. Live GeoPackage query  

Each feature typically includes:

- `GID_*` / `NAME_*` — admin codes and names  
- `geometry` — GeoJSON (Polygon / MultiPolygon)  
- Optional GHS fields when enrich ran: `ghsPopulation`, `ghsPopCenter`, `ghsBuiltWeight`, …

Display-cleaned collections also set `_mapPaint: true` on the FeatureCollection.

## Architecture

```
src/
├── main.cpp           # CLI, country loop, cache write, optional display-clean
├── gpkg_reader.h/cpp  # GeoPackage → features (OGR) + resolution simplify
├── geo_merge.h/cpp    # Geometry union (GEOS WKB)
├── geo_display.h/cpp  # Map-paint clean (holes / islands / coast) — parity with TS
├── ghs_enrich.h/cpp   # GeoTIFF sampling + PIP
├── pip.h              # Ray-casting point-in-polygon
└── types.h            # BoundaryFeature, BoundaryResult

scripts/
├── vs-env.mjs         # Inject MSVC INCLUDE/LIB/PATH via vcvarsall
├── ensure-vcpkg.mjs   # Recover VCPKG_ROOT → cpp/.vcpkg if needed
├── cmake.mjs          # cmake wrapper (cwd = cpp/)
└── ninja.mjs          # ninja wrapper with default -j/-l
```

Tests: `cpp/tests/unit/test_geo_display.cpp` (Catch2) — island drop + hole strip.

### Key Design Decisions

- **No OpenMP** — GDAL/PROJ/GEOS are not thread-safe for concurrent raster reads + transforms. Sequential is I/O-bound anyway.
- **WKB precision** — union uses WKB to avoid WKT float drift.
- **Display clean is not Douglas–Peucker** — spike/ear filter is local; dense smooth coasts may keep most vertices. Pair with `--resolution` and MapLibre `tolerance` for density.
- **PROJ_DATA** — set at startup to the exe dir where `proj.db` is co-located.
- **Cross-platform** — Windows (MSVC + Ninja) and Linux (GCC/Clang) via vcpkg.

### Further I/O notes

GeoPackage full-layer scans dominate read time for large countries. Optional improvements: SQLite indexes on `GID_*`, or per-country `.gpkg` shards. See historical notes in git history / `docs/cpp-port.md` if present.
