export interface GadmCache {
    get(key: string): Promise<any>;
    set(key: string, value: any): Promise<void>;
}
/**
 * Returns a list of directories to search for GADM cache files, in order of priority.
 */
export declare function getCacheDirs(): string[];
/**
 * Normalizes a value into a safe filename-friendly string.
 */
export declare function safeId(id: string): string;
/**
 * Read from the GADM JSON cache.
 */
export declare function readGadmCache<T>(key: string, countryCode?: string, externalCache?: GadmCache): Promise<T | null>;
/**
 * Write to the primary GADM JSON cache.
 */
export declare function writeGadmCache(key: string, data: any, countryCode?: string, externalCache?: GadmCache): Promise<void>;
