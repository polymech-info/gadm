import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);
/**
 * Returns a list of directories to search for GADM cache files, in order of priority.
 */
export function getCacheDirs() {
    const dirs = [];
    if (process.env.GADM_CACHE)
        dirs.push(resolve(process.env.GADM_CACHE));
    dirs.push(resolve(process.cwd(), 'cache/gadm'));
    dirs.push(resolve(_dirname, '../cache/gadm'));
    return [...new Set(dirs)];
}
/**
 * Normalizes a value into a safe filename-friendly string.
 */
export function safeId(id) {
    return id.replace(/[^a-zA-Z0-9\.\-_]/g, '_').substring(0, 50);
}
/**
 * Read from the GADM JSON cache.
 */
export async function readGadmCache(key, countryCode, externalCache) {
    if (externalCache) {
        try {
            const cached = await externalCache.get(key);
            if (cached)
                return cached;
        }
        catch { /* ignore */ }
    }
    const dirs = getCacheDirs();
    for (const dir of dirs) {
        const paths = [];
        if (countryCode) {
            paths.push(join(dir, countryCode, `${key}.json`));
        }
        paths.push(join(dir, `${key}.json`));
        // Special handling for boundary fallbacks (C++ parity)
        if (key.startsWith('boundary_') && countryCode) {
            const parts = key.split('_');
            const level = parts[parts.length - 1];
            if (level) {
                paths.push(join(dir, countryCode, `boundary_${countryCode}_${level}.json`));
                paths.push(join(dir, `boundary_${countryCode}_${level}.json`));
            }
        }
        for (const p of paths) {
            if (existsSync(p)) {
                try {
                    const raw = JSON.parse(readFileSync(p, 'utf-8'));
                    // Filter C++ full-country file if we were looking for a specific sub-region
                    if (p.includes(`boundary_${countryCode}_`) && !p.includes(key) && raw.features) {
                        const originalId = key.replace('boundary_', '').replace(/_\d+$/, '');
                        const gidPrefix = originalId.includes('.') ? originalId + '.' : null;
                        if (gidPrefix) {
                            const filteredFeatures = raw.features.filter((f) => f.code && f.code.startsWith(originalId) // using originalId directly covers both exact and sub-regions
                            );
                            if (filteredFeatures.length === 0)
                                continue;
                            // Rehydrate the boundary format
                            return {
                                type: 'FeatureCollection',
                                features: filteredFeatures.map((f) => {
                                    const { geometry, code, name, ...enrichment } = f;
                                    return {
                                        type: 'Feature',
                                        properties: { name, code, ...enrichment },
                                        geometry
                                    };
                                })
                            };
                        }
                    }
                    return raw;
                }
                catch (e) {
                    console.warn(`[gadm-cache] Failed to read cache from ${p}:`, e);
                }
            }
        }
    }
    return null;
}
/**
 * Write to the primary GADM JSON cache.
 */
export async function writeGadmCache(key, data, countryCode, externalCache) {
    if (externalCache) {
        try {
            await externalCache.set(key, data);
            return;
        }
        catch { /* ignore */ }
    }
    const primaryDir = getCacheDirs()[0];
    const targetDir = countryCode ? join(primaryDir, countryCode) : primaryDir;
    const targetFile = join(targetDir, `${key}.json`);
    try {
        if (!existsSync(targetDir)) {
            mkdirSync(targetDir, { recursive: true });
        }
        writeFileSync(targetFile, JSON.stringify(data));
    }
    catch (e) {
        console.warn(`[gadm-cache] Failed to write cache to ${targetFile}:`, e);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2FjaGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvY2FjaGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFVBQVUsRUFBRSxZQUFZLEVBQUUsYUFBYSxFQUFFLFNBQVMsRUFBRSxNQUFNLElBQUksQ0FBQztBQUN4RSxPQUFPLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsTUFBTSxNQUFNLENBQUM7QUFDOUMsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLEtBQUssQ0FBQztBQUVwQyxNQUFNLFNBQVMsR0FBRyxhQUFhLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNqRCxNQUFNLFFBQVEsR0FBRyxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUM7QUFPcEM7O0dBRUc7QUFDSCxNQUFNLFVBQVUsWUFBWTtJQUN4QixNQUFNLElBQUksR0FBRyxFQUFFLENBQUM7SUFDaEIsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVU7UUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUM7SUFDdkUsSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxFQUFFLFlBQVksQ0FBQyxDQUFDLENBQUM7SUFDaEQsSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsUUFBUSxFQUFFLGVBQWUsQ0FBQyxDQUFDLENBQUM7SUFDOUMsT0FBTyxDQUFDLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztBQUM5QixDQUFDO0FBRUQ7O0dBRUc7QUFDSCxNQUFNLFVBQVUsTUFBTSxDQUFDLEVBQVU7SUFDN0IsT0FBTyxFQUFFLENBQUMsT0FBTyxDQUFDLG9CQUFvQixFQUFFLEdBQUcsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFD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