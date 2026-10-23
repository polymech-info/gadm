import { type GeoJSONCollection, type GeoJSONFeature } from './items.js';
import type { GadmCache } from './gpkg-reader.js';
import { type GHSEnrichOptions } from './enrich-ghs.js';
export interface SearchRegionsOptions {
    query: string;
    contentLevel?: number;
    geojson?: boolean;
    country?: string;
    cache?: GadmCache;
}
export interface SearchRegionsResult {
    data?: Record<string, string>[];
    type?: string;
    features?: GeoJSONFeature[];
    error?: string;
}
/**
 * Search for admin regions by name.
 * Returns metadata rows or GeoJSON FeatureCollection.
 */
export declare function searchRegions(opts: SearchRegionsOptions): Promise<SearchRegionsResult>;
/**
 * Get boundary GeoJSON for a specific GADM ID.
 * Optionally enriches the boundary with GHS Population and Built-up Area data!
 */
export declare function getBoundary(gadmId: string, contentLevel?: number, cache?: GadmCache, enrichOptions?: GHSEnrichOptions, resolution?: number): Promise<GeoJSONCollection | {
    error: string;
}>;
export interface RegionNamesOptions {
    admin: string;
    contentLevel?: number;
    depth?: number | string;
    cache?: GadmCache;
}
/**
 * Get names for all sub-regions of an admin area, optionally recursing through levels.
 */
export declare function getRegionNames(opts: RegionNamesOptions): Promise<{
    data: Record<string, string>[];
} | {
    error: string;
}>;
