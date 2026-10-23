export declare const NAME_COLS: readonly ["NAME_0", "NAME_1", "NAME_2", "NAME_3", "NAME_4", "NAME_5"];
export declare const GID_COLS: readonly ["GID_0", "GID_1", "GID_2", "GID_3", "GID_4", "GID_5"];
export type GadmRow = Record<string, string>;
/**
 * Load the GADM parquet database into memory (lazy, cached).
 * Returns an array of plain objects keyed by column name.
 */
export declare function loadDatabase(): Promise<GadmRow[]>;
/**
 * Get column names.
 */
export declare function getColumns(): string[];
/**
 * Reset the cache (useful for testing).
 */
export declare function resetCache(): void;
