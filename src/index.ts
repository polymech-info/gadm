/**
 * @polymech/gadm — TypeScript port of pygadm + gadm_wrapper.
 */

export { loadDatabase, getColumns, resetCache } from './database.js';
export type { GadmRow } from './database.js';

export { getNames } from './names.js';
export type { NamesOptions, NamesResult } from './names.js';

export { getItems } from './items.js';
export type { ItemsOptions, GeoJSONFeature, GeoJSONCollection } from './items.js';

export { searchRegions, getBoundary, getRegionNames } from './wrapper.js';
export type {
    SearchRegionsOptions,
    SearchRegionsResult,
    RegionNamesOptions,
} from './wrapper.js';

export { buildTree, walkDFS, walkBFS, walkLevel, leaves, findNode } from './tree.js';
export type { GADMNode, GADMTree, BuildTreeOptions } from './tree.js';

export {
    setGpkgPath,
    getBoundaryFromGpkg,
    getHierarchyByPoint,
    getHierarchyByPointFromCache,
    queryUniqueGidsInBbox,
    queryUniqueGidsInBboxAsync,
} from './gpkg-reader.js';
export type { BoundaryFeature, BoundaryResult, GadmPointResult } from './gpkg-reader.js';

export { getNeighbors, levelFromGid, parentAdminGid } from './neighbors.js';
export type { NeighborsOptions, NeighborsResult, NeighborRegion } from './neighbors.js';

export {
    simplifyBoundaryForMap,
    prepareBoundaryForMap,
    isMapPaintReady,
    smoothCoastRing,
    smoothCoastGeometry,
    stripInteriorRings,
    dropSmallOuterIslands,
    ringMinWidthKm,
    MIN_OUTER_ISLAND_WIDTH_KM,
} from './simplify-map.js';
export type { MapSimplifyOpts, CoastSmoothOpts } from './simplify-map.js';

export { enrichFeatureWithGHS } from './enrich-ghs.js';
export type { GHSEnrichOptions, GHSEnrichResult } from './enrich-ghs.js';
