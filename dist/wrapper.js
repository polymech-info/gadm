/**
 * Wrapper API — replaces gadm_wrapper.py CLI.
 *
 * Provides the same 3 operations: searchRegions, getBoundary, getRegionNames.
 * Includes file-based caching identical to the Python wrapper.
 */
import { getNames } from './names.js';
import { getItems } from './items.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { enrichFeatureWithGHS } from './enrich-ghs.js';
// ---------- cache ----------
const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);
const LOCAL_CACHE_DIR = join(_dirname, '../cache/gadm');
const CACHE_DIR = process.env.GADM_CACHE || LOCAL_CACHE_DIR;
function getCacheKey(prefix, value) {
    const safeValue = value.replace(/[^a-zA-Z0-9\.\-_]/g, '_').substring(0, 50);
    return `${prefix}_${safeValue}`;
}
function cachePath(key) {
    return join(CACHE_DIR, `${key}.json`);
}
async function readCache(key, extCache) {
    if (extCache) {
        try {
            const cached = await extCache.get(key);
            if (cached)
                return cached;
        }
        catch { }
        return null; // fallback or ignore
    }
    const path = cachePath(key);
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
async function writeCache(key, data, extCache) {
    if (extCache) {
        try {
            await extCache.set(key, data);
        }
        catch { }
        return;
    }
    const path = cachePath(key);
    try {
        mkdirSync(dirname(path), { recursive: true });
        console.log('Writing cache:', path);
        writeFileSync(path, JSON.stringify(data));
    }
    catch (e) {
        console.error('Cache write failed:', e);
    }
}
/**
 * Search for admin regions by name.
 * Returns metadata rows or GeoJSON FeatureCollection.
 */
export async function searchRegions(opts) {
    const { query, contentLevel, geojson = false, country, cache } = opts;
    const prefix = `search_${contentLevel ?? 'all'}_${geojson ? 'geo' : 'meta'}_${country ?? 'all'}`;
    const key = getCacheKey(prefix, query);
    const cached = await readCache(key, cache);
    if (cached)
        return cached;
    try {
        if (geojson) {
            // GeoJSON mode — use Items
            const itemOpts = { name: [query], cache };
            if (contentLevel != null)
                itemOpts.contentLevel = contentLevel;
            try {
                const gdf = await getItems(itemOpts);
                const output = {
                    type: 'FeatureCollection',
                    features: gdf.features,
                };
                await writeCache(key, output, cache);
                return output;
            }
            catch (e) {
                // Try first part if comma-separated
                if (query.includes(',')) {
                    const first = query.split(',')[0].trim();
                    itemOpts.name = [first];
                    try {
                        const gdf = await getItems(itemOpts);
                        const output = {
                            type: 'FeatureCollection',
                            features: gdf.features,
                        };
                        await writeCache(key, output, cache);
                        return output;
                    }
                    catch {
                        return { data: [] };
                    }
                }
                throw e;
            }
        }
        else {
            // Metadata mode — use Names
            const namesOpts = { name: query };
            if (contentLevel != null)
                namesOpts.contentLevel = contentLevel;
            if (country)
                namesOpts.admin = country;
            try {
                const result = await getNames(namesOpts);
                const output = { data: result.rows };
                await writeCache(key, output, cache);
                return output;
            }
            catch {
                // Try first part if comma-separated
                if (query.includes(',')) {
                    const first = query.split(',')[0].trim();
                    namesOpts.name = first;
                    try {
                        const result = await getNames(namesOpts);
                        const output = { data: result.rows };
                        await writeCache(key, output, cache);
                        return output;
                    }
                    catch {
                        return { data: [] };
                    }
                }
                return { data: [] };
            }
        }
    }
    catch (e) {
        return { error: e.stack || e.message };
    }
}
import { getBoundaryFromGpkg } from './gpkg-reader.js';
/**
 * Get boundary GeoJSON for a specific GADM ID.
 * Optionally enriches the boundary with GHS Population and Built-up Area data!
 */
export async function getBoundary(gadmId, contentLevel, cache, enrichOptions, resolution = 3) {
    const enrichKeySuffix = enrichOptions ? '_enriched' : '';
    const keySuffix = `${contentLevel ?? 'auto'}_${gadmId}${enrichKeySuffix}`;
    const key = getCacheKey(`boundary`, keySuffix);
    // 1. Check if we already have the EXACT requested state cached
    const cached = await readCache(key, cache);
    if (cached) {
        return cached;
    }
    // 2. Fetch the base geometry
    let baseCollection = null;
    // First try the far superior SQLite GeoPackage
    const gpkgRes = await getBoundaryFromGpkg(gadmId, contentLevel, cache, resolution);
    if (gpkgRes) {
        baseCollection = gpkgRes;
    }
    else {
        // Fallback exactly as before to Parquet mode
        const baseKey = getCacheKey(`boundary_${contentLevel ?? 'auto'}`, gadmId);
        const baseCached = await readCache(baseKey, cache);
        if (baseCached) {
            baseCollection = baseCached;
        }
        else {
            try {
                const gdf = await getItems({ admin: [gadmId], contentLevel, cache });
                if (gdf.features.length === 0) {
                    return { error: 'Region not found' };
                }
                baseCollection = gdf;
                await writeCache(baseKey, baseCollection, cache);
            }
            catch (e) {
                return { error: e.message };
            }
        }
    }
    let collectionToReturn = baseCollection;
    // 3. Apply GeoTIFF enrichment if requested — skip if already enriched (e.g. from C++ cache)
    const alreadyEnriched = baseCollection?.features?.some((f) => f.properties?.ghsPopulation !== undefined);
    if (enrichOptions && !alreadyEnriched && baseCollection && baseCollection.features) {
        // Deep clone so we don't mutate an in-memory cached object accidentally
        collectionToReturn = JSON.parse(JSON.stringify(baseCollection));
        for (const feature of collectionToReturn.features) {
            try {
                const enrichResult = await enrichFeatureWithGHS(feature, enrichOptions);
                Object.assign(feature.properties, enrichResult);
                // Set the default population property to the highly accurate GHS number
                if (enrichResult.ghsPopulation !== undefined) {
                    feature.properties.population = enrichResult.ghsPopulation;
                }
            }
            catch (e) {
                console.error('GHS Enrichment failed for feature', feature.properties?.name || '', e);
            }
        }
        await writeCache(key, collectionToReturn, cache);
    }
    return collectionToReturn;
}
/**
 * Get names for all sub-regions of an admin area, optionally recursing through levels.
 */
export async function getRegionNames(opts) {
    const { admin, contentLevel, depth = 1, cache } = opts;
    const key = getCacheKey(`names_${admin}_${contentLevel}_${depth}`, 'names');
    const cached = await readCache(key, cache);
    if (cached)
        return cached;
    try {
        const allResults = [];
        // Determine starting level from admin code
        let startLevel;
        if (contentLevel != null) {
            startLevel = contentLevel;
        }
        else {
            // GID format: XXX.L1.L2_1 — count dots + 1
            startLevel = admin.split('.').length; // "ESP" = 1 dot → level 1 start
            if (!admin.includes('.'))
                startLevel = 1; // country code → start at level 1
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
                if (result.rows.length === 0)
                    break;
                allResults.push(...result.rows);
            }
            catch {
                break; // Level doesn't exist
            }
            currentLevel++;
        }
        const output = { data: allResults };
        await writeCache(key, output, cache);
        return output;
    }
    catch (e) {
        return { error: e.stack || e.message };
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid3JhcHBlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy93cmFwcGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7OztHQUtHO0FBQ0gsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLFlBQVksQ0FBQztBQUN0QyxPQUFPLEVBQUUsUUFBUSxFQUErQyxNQUFNLFlBQVksQ0FBQztBQUNuRixPQUFPLEVBQUUsVUFBVSxFQUFFLFlBQVksRUFBRSxhQUFhLEVBQUUsU0FBUyxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBQ3hFLE9BQU8sRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLE1BQU0sTUFBTSxDQUFDO0FBQ3JDLE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFHcEMsT0FBTyxFQUFFLG9CQUFvQixFQUF5QixNQUFNLGlCQUFpQixDQUFDO0FBRTlFLDhCQUE4QjtBQUU5QixNQUFNLFNBQVMsR0FBRyxhQUFhLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNqRCxNQUFNLFFBQVEsR0FBRyxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFcEMsTUFBTSxlQUFlLEdBQUcsSUFBSSxDQUFDLFFBQVEsRUFBRSxlQUFlLENBQUMsQ0FBQztBQUN4RCxNQUFNLFNBQVMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsSUFBSSxlQUFlLENBQUM7QUFFNUQsU0FBUyxXQUFXLENBQUMsTUFBYyxFQUFFLEtBQWE7SUFDOUMsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLE9BQU8sQ0FBQyxvQkFBb0IsRUFBRSxHQUFHLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQzVFLE9BQU8sR0FBRyxNQUFNLElBQUksU0FBUyxFQUFFLENBQUM7QUFDcEMsQ0FBQztBQUVELFNBQVMsU0FBUyxDQUFDLEdBQVc7SUFDMUIsT0FBTyxJQUFJLENBQUMsU0FBUyxFQUFFLEdB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