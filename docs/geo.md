# Geospatial Architecture & Rendering Strategy

How we process, store, and render GADM administrative boundaries for Places (MapLibre GL JS).  
Property / file schema: [annotations.md](./annotations.md).

## The problem

Raw GADM outlines are heavy. A detailed L1/L2 region can be multi‑MB GeoJSON. That hurts bandwidth, JSON parse time, and MapLibre pan/zoom (too many vertices on stroke fills).

## Approaches considered

### 1. Pre-cached simplified GeoJSON (chosen)

Bake once (TS `boundaries` / C++ `boundaries.exe`), serve FeatureCollections from `cache/gadm/`.

Two complementary steps:

| Step | Tooling | Role |
|------|---------|------|
| **Resolution bake** | turf / `OGR_G_SimplifyPreserveTopology` (`--resolution`) | Drop colinear vertices (~200 m–500 m tolerance) |
| **Display clean** | `prepareBoundaryForMap` / `--display-clean` | Strip lake holes, drop outer islands &lt; ~5 km min width, remove coastline V-spikes / ears; stamp `_mapPaint` |

- **Pros:** Small payloads, simple file cache, MapLibre consumes GeoJSON natively; clients skip reprocessing when `_mapPaint` is set.  
- **Cons:** Per-feature simplify can open tiny border slivers; display clean is not a full topological mesh.

### 2. Mapbox Vector Tiles (MVT)

Viewport tiles, zoom-dependent detail.

- **Pros:** Best for global, always-on admin layers.  
- **Cons:** Tile server or huge tippecanoe pyramids — overkill for **selected** regions.

### 3. TopoJSON

Shared edges encoded once.

- **Pros:** Smaller than GeoJSON, fewer gaps.  
- **Cons:** Extra decode (`topojson-client`) before MapLibre.

## Current direction

Places loads **on-demand selected / viewport** GADM regions (hover-add, picker), not the whole admin globe.

**Strategy:** Option 1 — resolution bake + display clean → lightweight GeoJSON in `cache/gadm/`, optional `?simplify=map` on the API, MapLibre `tolerance` for remaining density.

C++ L0 example (geometry-only, all countries):

```bash
.\dist\win-x64\boundaries.exe --country=all --level=0 --display-clean --force \
  --cache-dir=cache/gadm --gpkg=data/gadm_410.gpkg \
  --pop-tiff=__none__.tif --built-tiff=__none__.tif --resolution=3
```

Details of fields and `_mapPaint`: [annotations.md](./annotations.md).
