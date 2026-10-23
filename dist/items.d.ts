import { type GadmCache } from './gpkg-reader.js';
export interface ItemsOptions {
    /** Administrative area name(s). Cannot use with `admin`. */
    name?: string | string[];
    /** GADM admin code(s). Cannot use with `name`. */
    admin?: string | string[];
    /** Target content level (0-5). -1 = auto-detect. */
    contentLevel?: number;
    /** Optional external cache implementation to bypass file cache */
    cache?: GadmCache;
}
import type { GHSEnrichResult } from './enrich-ghs.js';
export type GeoJSONFeatureProperties = Record<string, string | number | boolean | any> & GHSEnrichResult;
export interface GeoJSONFeature {
    type: 'Feature';
    properties: GeoJSONFeatureProperties;
    geometry: any;
}
export interface GeoJSONCollection {
    type: 'FeatureCollection';
    features: GeoJSONFeature[];
}
/**
 * Fetch GeoJSON boundaries for administrative areas.
 * Tries local GeoPackage first, falls back to GADM CDN.
 */
export declare function getItems(opts: ItemsOptions): Promise<GeoJSONCollection>;
