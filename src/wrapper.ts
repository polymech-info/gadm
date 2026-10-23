/**
 * Wrapper API — replaces gadm_wrapper.py CLI.
 *
 * Provides the same 3 operations: searchRegions, getBoundary, getRegionNames.
 * Includes file-based caching identical to the Python wrapper.
 */
import { getNames } from './names.js';
import { getItems, type GeoJSONCollection, type GeoJSONFeature } from './items.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import type { GadmCache } from './gpkg-reader.js';
import { enrichFeatureWithGHS, type GHSEnrichOptions } from './enrich-ghs.js';

// ---------- cache ----------

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const LOCAL_CACHE_DIR = join(_dirname, '../cache/gadm');
const CACHE_DIR = process.env.GADM_CACHE || LOCAL_CACHE_DIR;

function getCacheKey(prefix: string, value: string): string {
    const safeValue = value.replace(/[^a-zA-Z0-9\.\-_]/g, '_').substring(0, 50);
    return `${prefix}_${safeValue}`;
}

function cachePath(key: string): string {
    return join(CACHE_DIR, `${key}.json`);
}

async function readCache<T>(key: string, extCache?: GadmCache): Promise<T | null> {
    if (extCache) {
        try {
            const cached = await extCache.get(key);
            if (cached) return cached as T;
        } catch { }
        return null; // fallback or ignore
    }
    const path = cachePath(key);
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8')) as T;
    } catch {
        return null;
    }
}

async function writeCache(key: string, data: unknown, extCache?: GadmCache): Promise<void> {
    if (extCache) {
        try { await extCache.set(key, data); } catch { }
        return;
    }
    const path = cachePath(key);
    try {
        mkdirSync(dirname(path), { recursive: true });
        console.log('Writing cache:', path);
        writeFileSync(path, JSON.stringify(data));
    } catch (e) {
        console.error('Cache write failed:', e);
    }
}

// ---------- public API ----------

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
export async function searchRegions(opts: SearchRegionsOptions): Promise<SearchRegionsResult> {
    const { query, contentLevel, geojson = false, country, cache } = opts;
    const prefix = `search_${contentLevel ?? 'all'}_${geojson ? 'geo' : 'meta'}_${country ?? 'all'}`;
    const key = getCacheKey(prefix, query);

    const cached = await readCache<SearchRegionsResult>(key, cache);
    if (cached) return cached;

    try {
        if (geojson) {
            // GeoJSON mode — use Items
            const itemOpts: any = { name: [query], cache };
            if (contentLevel != null) itemOpts.contentLevel = contentLevel;

            try {
                const gdf = await getItems(itemOpts);
                const output: SearchRegionsResult = {
                    type: 'FeatureCollection',
                    features: gdf.features,
                };
                await writeCache(key, output, cache);
                return output;
            } catch (e) {
                // Try first part if comma-separated
                if (query.includes(',')) {
                    const first = query.split(',')[0].trim();
                    itemOpts.name = [first];
                    try {
                        const gdf = await getItems(itemOpts);
                        const output: SearchRegionsResult = {
                            type: 'FeatureCollection',
                            features: gdf.features,
                        };
                        await writeCache(key, output, cache);
                        return output;
                    } catch {
                        return { data: [] };
                    }
                }
                throw e;
            }
        } else {
            // Metadata mode — use Names
            const namesOpts: any = { name: query };
            if (contentLevel != null) namesOpts.contentLevel = contentLevel;
            if (country) namesOpts.admin = country;

            try {
                const result = await getNames(namesOpts);
                const output: SearchRegionsResult = { data: result.rows };
                await writeCache(key, output, cache);
                return output;
            } catch {
                // Try first part if comma-separated
                if (query.includes(',')) {
                    const first = query.split(',')[0].trim();
                    namesOpts.name = first;
                    try {
                        const result = await getNames(namesOpts);
                        const output: SearchRegionsResult = { data: result.rows };
                        await writeCache(key, output, cache);
                        return output;
                    } catch {
                        return { data: [] };
                    }
                }
                return { data: [] };
            }
        }
    } catch (e: any) {
        return { error: e.stack || e.message };
    }
}

import { getBoundaryFromGpkg } from './gpkg-reader.js';

/**
 * Get boundary GeoJSON for a specific GADM ID.
 * Optionally enriches the boundary with GHS Population and Built-up Area data!
 */
export async function getBoundary(
    gadmId: string,
    contentLevel?: number,
    cache?: GadmCache,
    enrichOptions?: GHSEnrichOptions,
    resolution: number = 3
): Promise<GeoJSONCollection | { error: string }> {

    const enrichKeySuffix = enrichOptions ? '_enriched' : '';
    const keySuffix = `${contentLevel ?? 'auto'}_${gadmId}${enrichKeySuffix}`;
    const key = getCacheKey(`boundary`, keySuffix);

    // 1. Check if we already have the EXACT requested state cached
    const cached = await readCache<GeoJSONCollection>(key, cache);
    if (cached) {
        return cached;
    }

    // 2. Fetch the base geometry
    let baseCollection: GeoJSONCollection | null = null;

    // First try the far superior SQLite GeoPackage
    const gpkgRes = await getBoundaryFromGpkg(gadmId, contentLevel, cache, resolution);
    if (gpkgRes) {

        baseCollection = gpkgRes;
    } else {
        // Fallback exactly as before to Parquet mode

        const baseKey = getCacheKey(`boundary_${contentLevel ?? 'auto'}`, gadmId);
        const baseCached = await readCache<GeoJSONCollection>(baseKey, cache);
        if (baseCached) {
            baseCollection = baseCached;
        } else {
            try {
                const gdf = await getItems({ admin: [gadmId], contentLevel, cache });
                if (gdf.features.length === 0) {
                    return { error: 'Region not found' };
                }
                baseCollection = gdf;
                await writeCache(baseKey, baseCollection, cache);
            } catch (e: any) {
                return { error: e.message };
            }
        }
    }

    let collectionToReturn = baseCollection;

    // 3. Apply GeoTIFF enrichment if requested — skip if already enriched (e.g. from C++ cache)
    const alreadyEnriched = baseCollection?.features?.some(
        (f: any) => f.properties?.ghsPopulation !== undefined
    );
    if (enrichOptions && !alreadyEnriched && baseCollection && baseCollection.features) {
        // Deep clone so we don't mutate an in-memory cached object accidentally
        collectionToReturn = JSON.parse(JSON.stringify(baseCollection));
        for (const feature of collectionToReturn.features!) {
            try {
                const enrichResult = await enrichFeatureWithGHS(feature, enrichOptions);
                Object.assign(feature.properties, enrichResult);

                // Set the default population property to the highly accurate GHS number
                if (enrichResult.ghsPopulation !== undefined) {
                    feature.properties.population = enrichResult.ghsPopulation;
                }
            } catch (e) {
                console.error('GHS Enrichment failed for feature', feature.properties?.name || '', e);
            }
        }
        await writeCache(key, collectionToReturn, cache);
    }

    return collectionToReturn;
}

export interface RegionNamesOptions {
    admin: string;
    contentLevel?: number;
    depth?: number | string;
    cache?: GadmCache;
}

/**
 * Get names for all sub-regions of an admin area, optionally recursing through levels.
 */
export async function getRegionNames(opts: RegionNamesOptions): Promise<{ data: Record<string, string>[] } | { error: string }> {
    const { admin, contentLevel, depth = 1, cache } = opts;
    const key = getCacheKey(`names_${admin}_${contentLevel}_${depth}`, 'names');
    const cached = await readCache<{ data: Record<string, string>[] }>(key, cache);
    if (cached) return cached;

    try {
        const allResults: Record<string, string>[] = [];

        // Determine starting level from admin code
        let startLevel: number;
        if (contentLevel != null) {
            startLevel = contentLevel;
        } else {
            // GID format: XXX.L1.L2_1 — count dots + 1
            startLevel = admin.split('.').length;  // "ESP" = 1 dot → level 1 start
            if (!admin.includes('.')) startLevel = 1; // country code → start at level 1
        }

        // Handle infinite depth
        const depthStr = String(depth).toLowerCase();
        const limit = (depthStr === 'infinite' || depthStr === 'inf' || depthStr === '-1')
            ? 5
            : Number(depth);

        let currentLevel = startLevel;

        for (let i = 0; i < limit; i++) {
            try {
                const result = await getNames({
                    admin,
                    contentLevel: currentLevel,
                });
                if (result.rows.length === 0) break;
                allResults.push(...result.rows);
            } catch {
                break; // Level doesn't exist
            }
            currentLevel++;
        }

        const output = { data: allResults };
        await writeCache(key, output, cache);
        return output;
    } catch (e: any) {
        return { error: e.stack || e.message };
    }
}
