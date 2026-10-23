export interface GeoJSONGeometry {
    type: string;
    coordinates: any;
}
export interface BoundaryFeature {
    type: 'Feature';
    properties: Record<string, any>;
    geometry: GeoJSONGeometry;
}
export interface BoundaryResult {
    type: 'FeatureCollection';
    features: BoundaryFeature[];
}
/** Set or override the GeoPackage file path */
export declare function setGpkgPath(p: string): void;
/** Parse GeoPackage Binary blob → GeoJSON geometry */
export declare function parseGpkgGeometry(blob: Buffer): GeoJSONGeometry;
export interface GadmCache {
    get(key: string): Promise<any>;
    set(key: string, value: any): Promise<void>;
}
export declare function getBoundaryFromGpkg(gadmId: string, contentLevel?: number, externalCache?: GadmCache, resolution?: number): Promise<BoundaryResult | null>;
export declare function containsPoint(geom: GeoJSONGeometry, pt: [number, number]): boolean;
export interface GadmPointResult {
    level: number;
    gadmName: string | null;
    gid: string | null;
}
/**
 * Distinct GID/NAME at `level` whose leaf geometries overlap the given bbox (rtree).
 * Sync — blocks the event loop (prefer {@link queryUniqueGidsInBboxAsync} on HTTP paths).
 */
export declare function queryUniqueGidsInBbox(bbox: [number, number, number, number], level: number): Array<{
    gid: string;
    name: string;
}>;
/**
 * Same as {@link queryUniqueGidsInBbox} but runs in a worker thread so the
 * HTTP event loop (gridsearch, health, pg) stays responsive while sqlite works.
 */
export declare function queryUniqueGidsInBboxAsync(bbox: [number, number, number, number], level: number): Promise<Array<{
    gid: string;
    name: string;
}>>;
/**
 * Perform a spatial query to find the exact GADM hierarchy containing a point.
 */
export declare function getHierarchyByPoint(lat: number, lon: number): GadmPointResult[] | null;
/**
 * Perform a point-in-polygon hierarchy query using only the pre-generated JSON cache.
 * Avoids any SQLite dependency.
 */
export declare function getHierarchyByPointFromCache(lat: number, lon: number, isoCode: string, additionalCacheDirs?: string[]): Promise<GadmPointResult[] | null>;
