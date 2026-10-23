/**
 * Display-oriented boundary cleanup for MapLibre / map caches.
 *
 * - Strip interior rings (optional): GADM lakes become dense stroke holes.
 * - Drop outer islands whose bbox min width is under ~5 km (keep largest part).
 * - Remove coastline “V” spikes (3-vertex folds) and small harbour ears.
 * Scale thresholds from each ring’s bbox so L0 and L1 share one rule set.
 * Long fjords keep long legs and are preserved.
 *
 * Does not use booleanValid / buffer(0) / convex-hull fallbacks.
 * Keep in sync with pm-pics `src/modules/places/utils/simplify-boundary.ts`.
 */
/** Default: ignore outer islands narrower than this (bbox min side). */
export declare const MIN_OUTER_ISLAND_WIDTH_KM = 5;
export type CoastSmoothOpts = {
    maxTipDeg?: number;
    maxLegFrac?: number;
    minLegDeg?: number;
    minDetour?: number;
    maxEarAreaFrac?: number;
    maxPasses?: number;
};
export type MapSimplifyOpts = CoastSmoothOpts & {
    /** @deprecated Unused — MapLibre tolerance owns ring density. Kept for API compat. */
    maxRingPts?: number;
    /** @deprecated Unused — prefer minOuterWidthKm. Kept for API compat. */
    areaFraction?: number;
    /** @deprecated Unused — prefer minOuterWidthKm. Kept for API compat. */
    maxParts?: number;
    /**
     * Drop MultiPolygon outer parts whose bbox min width is below this (km).
     * Largest part is always kept. Default 5; `0` disables.
     */
    minOuterWidthKm?: number;
    keepHoles?: boolean;
    skipCoastSmooth?: boolean;
};
type Ring = number[][];
/** Smaller bbox side in km (lon scaled by cos(mid-lat)). */
export declare function ringMinWidthKm(ring: Ring): number;
/**
 * Drop small outer islands from MultiPolygon / collections.
 * Always keeps the largest exterior (by area) so Monaco / city-states still paint.
 */
export declare function dropSmallOuterIslands(geometry: GeoJSON.Geometry | null | undefined, minWidthKm?: number): GeoJSON.Geometry | null;
/** Drop 3-vertex V-spikes and small harbour ears on a closed ring. */
export declare function smoothCoastRing(ring: Ring, opts?: CoastSmoothOpts): Ring;
export declare function smoothCoastGeometry(geometry: GeoJSON.Geometry, opts?: CoastSmoothOpts): GeoJSON.Geometry;
export declare function stripInteriorRings(geometry: GeoJSON.Geometry | null | undefined): GeoJSON.Geometry | null;
/** True when FC was already display-cleaned (server or client). */
export declare function isMapPaintReady(input: GeoJSON.FeatureCollection | {
    features?: GeoJSON.Feature[];
    _mapPaint?: boolean;
} | null | undefined): boolean;
/** Map / cache FeatureCollection: hole strip + small-island drop + coast smooth. */
export declare function prepareBoundaryForMap(input: GeoJSON.FeatureCollection | {
    type?: string;
    features?: GeoJSON.Feature[];
    _mapPaint?: boolean;
}, opts?: MapSimplifyOpts): GeoJSON.FeatureCollection;
/** @deprecated Prefer prepareBoundaryForMap */
export declare function simplifyBoundaryForMap(input: GeoJSON.FeatureCollection | {
    type?: string;
    features?: GeoJSON.Feature[];
}, opts?: MapSimplifyOpts): GeoJSON.FeatureCollection;
export {};
