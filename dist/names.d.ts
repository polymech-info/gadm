/**
 * Names lookup — port of Python pygadm.Names class.
 *
 * Searches the GADM parquet database for admin areas by name or GID code.
 * Returns matching rows with NAME_{level} and GID_{level} columns.
 */
import { type GadmRow } from './database.js';
export interface NamesOptions {
    /** Administrative area name (cannot use with `admin`) */
    name?: string;
    /** GADM admin code like "FRA" or "ESP.6_1" (cannot use with `name`) */
    admin?: string;
    /** Target content level (0-5). -1 = auto-detect from the matched area */
    contentLevel?: number;
    /** If true, return all columns. If false, only NAME_{level} and GID_{level} */
    complete?: boolean;
}
export interface NamesResult {
    /** The matched/filtered rows */
    rows: GadmRow[];
    /** The resolved content level */
    level: number;
    /** Column names in the result */
    columns: string[];
}
/**
 * Look up administrative area names/codes in the GADM database.
 *
 * Port of Python `pygadm.Names(name, admin, content_level, complete)`.
 */
export declare function getNames(opts?: NamesOptions): Promise<NamesResult>;
