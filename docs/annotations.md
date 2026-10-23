# Boundary Feature Annotations

Ground-truth schema for FeatureCollections written by `@polymech/gadm` (TS cache + C++ `boundaries.exe`) and consumed by Places / MapLibre.

See also [geo.md](./geo.md) (why we pre-simplify) and [../cpp/README.md](../cpp/README.md) (bake CLI).

## Cache files

```
cache/gadm/{ISO3}/boundary_{ISO3}_{level}.json
cache/gadm/{ISO3}/boundary_{GID}_{level}.json   # when --split-levels includes that level
```

| Example | Contents |
|---------|----------|
| `ESP/boundary_ESP_0.json` | One country outline feature (`GID_0` / `NAME_0`) |
| `ESP/boundary_ESP_1.json` | One feature per L1 region (`GID_1` / `NAME_1`, often with GHS) |
| `ESP/boundary_ESP.6_1_4.json` | Split bake for one parent GID at level 4 |

Resolve order (`gpkg-reader`): exact `boundary_{gid}_{level}` → country `boundary_{ISO3}_{level}` (prefix filter) → GeoPackage.

## FeatureCollection

```jsonc
{
  "type": "FeatureCollection",
  "features": [ /* ... */ ],
  "_mapPaint": true   // only after prepareBoundaryForMap / --display-clean
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `type` | yes | Always `FeatureCollection` |
| `features` | yes | Zero or more GeoJSON Features |
| `_mapPaint` | no | Collection-level only. Means holes stripped, small islands dropped, coast smoothed — **clients must not re-run display clean**. |

Verified L0 after C++ `--display-clean` (no GHS):

```json
{
  "_mapPaint": true,
  "features": [{
    "type": "Feature",
    "properties": {
      "GID_0": "ESP",
      "NAME_0": "Spain",
      "isOuter": true
    },
    "geometry": { "type": "MultiPolygon", "coordinates": [/* … */] }
  }]
}
```

## Feature properties (what C++ actually writes)

From `cpp/src/main.cpp` — for bake level `lvl`:

| Property | When | Example (L0 / L1) |
|----------|------|-------------------|
| `GID_{lvl}` | always | `GID_0: "ESP"` · `GID_1: "ESP.10_1"` |
| `NAME_{lvl}` | always | `NAME_0: "Spain"` · `NAME_1: "Comunidad Valenciana"` |
| `isOuter` | when `dotCount(code) == lvl` | `true` on the matching admin depth |

**Not** written by the C++ baker: parent `GID_0` on an L1 feature, `VARNAME_*`, or client-only keys (`_gid`, `_fillColor`, …).

### Optional GHS (when POP/BUILT TIFFs exist)

| Property | Shape |
|----------|--------|
| `ghsPopulation` | number (rounded) |
| `ghsPopMaxDensity` | number (1 decimal) |
| `ghsPopCenter` | `[lon, lat]` (5 decimals) |
| `ghsPopCenters` | `[lon, lat, density][]` |
| `ghsBuiltWeight` | number (1 decimal) |
| `ghsBuiltMax` | number (1 decimal) |
| `ghsBuiltCenter` | `[lon, lat]` |
| `ghsBuiltCenters` | `[lon, lat, value][]` |

Skip enrich with nonexistent paths (`--pop-tiff=__none__.tif`). **ATA** can AV during enrich — use geometry-only for Antarctica.

Example L1 feature (enriched cache, then display-cleaned):

```json
{
  "GID_1": "ESP.10_1",
  "NAME_1": "Comunidad Valenciana",
  "isOuter": true,
  "ghsPopulation": 5066321,
  "ghsPopMaxDensity": 959,
  "ghsPopCenter": [-0.41735, 39.08099],
  "ghsPopCenters": [/* top peaks */],
  "ghsBuiltWeight": 494217102,
  "ghsBuiltMax": 10000,
  "ghsBuiltCenter": [-0.43173, 39.0625],
  "ghsBuiltCenters": [/* top peaks */]
}
```

## Geometry stages

| Pipeline stage | Geometry | Properties |
|----------------|----------|------------|
| GeoPackage read + merge | `Polygon` / `MultiPolygon`, may have **holes** | `GID_*` / `NAME_*` / `isOuter` |
| `--resolution N` | Fewer vertices (GEOS simplify) | unchanged |
| GHS enrich | unchanged | + `ghs*` |
| `--display-clean` / `prepareBoundaryForMap` | No holes; islands &lt; 5 km min width dropped (largest kept); coast spikes/ears removed; may become single `Polygon` | unchanged + FC `_mapPaint: true` |

Display clean is **local** (not Douglas–Peucker). Still use `resolution` + MapLibre `tolerance` for vertex budget.

## TypeScript

```ts
import {
  prepareBoundaryForMap,
  MIN_OUTER_ISLAND_WIDTH_KM, // 5
  type MapSimplifyOpts,
} from '@polymech/gadm';

const paint = prepareBoundaryForMap(fc); // stamps _mapPaint
```

Places HTTP: `?simplify=map` → same pass.

App helper `prepareBoundaryForMapPaint` **no-ops** when `_mapPaint` is already set.

## C++ bake (L0 map paint)

```bash
cd packages/gadm
npm run build:cpp:fast   # if needed

.\dist\win-x64\boundaries.exe --country=all --level=0 \
  --display-clean --min-outer-km=5 --force \
  --cache-dir=cache/gadm --gpkg=data/gadm_410.gpkg \
  --pop-tiff=__none__.tif --built-tiff=__none__.tif \
  --resolution=3
```

Parity: `src/simplify-map.ts` ↔ `cpp/src/geo_display.cpp`.

## Client overlays (not in cache)

| Key | Who sets it | Role |
|-----|-------------|------|
| `_gid` / `code` / `gid` | Places hover / layers | feature-state id |
| `_fillColor` / `_lineColor` | `GadmPicker` | selection palette |

## Related

- [geo.md](./geo.md) — simplify vs MVT / TopoJSON  
- [../readme.md](../readme.md) — package overview + map-paint section  
- [../cpp/README.md](../cpp/README.md) — build presets + CLI  
