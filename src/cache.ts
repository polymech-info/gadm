import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

export interface GadmCache {
    get(key: string): Promise<any>;
    set(key: string, value: any): Promise<void>;
}

/**
 * Returns a list of directories to search for GADM cache files, in order of priority.
 */
export function getCacheDirs(): string[] {
    const dirs = [];
    if (process.env.GADM_CACHE) dirs.push(resolve(process.env.GADM_CACHE));
    dirs.push(resolve(process.cwd(), 'cache/gadm'));
    dirs.push(resolve(_dirname, '../cache/gadm'));
    return [...new Set(dirs)];
}

/**
 * Normalizes a value into a safe filename-friendly string.
 */
export function safeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9\.\-_]/g, '_').substring(0, 50);
}

/**
 * Read from the GADM JSON cache.
 */
export async function readGadmCache<T>(
    key: string,
    countryCode?: string,
    externalCache?: GadmCache
): Promise<T | null> {
    if (externalCache) {
        try {
            const cached = await externalCache.get(key);
            if (cached) return cached as T;
        } catch { /* ignore */ }
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
                            const filteredFeatures = raw.features.filter((f: any) =>
                                f.code && f.code.startsWith(originalId) // using originalId directly covers both exact and sub-regions
                            );
                            if (filteredFeatures.length === 0) continue;

                            // Rehydrate the boundary format
                            return {
                                type: 'FeatureCollection',
                                features: filteredFeatures.map((f: any) => {
                                    const { geometry, code, name, ...enrichment } = f;
                                    return {
                                        type: 'Feature',
                                        properties: { name, code, ...enrichment },
                                        geometry
                                    };
                                })
                            } as T;
                        }
                    }

                    return raw as T;
                } catch (e) {
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
export async function writeGadmCache(
    key: string,
    data: any,
    countryCode?: string,
    externalCache?: GadmCache
): Promise<void> {
    if (externalCache) {
        try {
            await externalCache.set(key, data);
            return;
        } catch { /* ignore */ }
    }

    const primaryDir = getCacheDirs()[0];
    const targetDir = countryCode ? join(primaryDir, countryCode) : primaryDir;
    const targetFile = join(targetDir, `${key}.json`);

    try {
        if (!existsSync(targetDir)) {
            mkdirSync(targetDir, { recursive: true });
        }
        writeFileSync(targetFile, JSON.stringify(data));
    } catch (e) {
        console.warn(`[gadm-cache] Failed to write cache to ${targetFile}:`, e);
    }
}
