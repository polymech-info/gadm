import { type GadmCache } from './gpkg-reader.js';
export interface NeighborsOptions {
    gid: string;
    /** Target admin level; default inferred from GID dots. */
    level?: number;
    cache?: GadmCache;
}
export interface NeighborRegion {
    gid: string;
    gadmName: string;
    level: number;
    /** Approximate centroid for map pins [lng, lat]. */
    lng?: number;
    lat?: number;
}
export type NeighborsResult = {
    data: NeighborRegion[];
} | {
    error: string;
};
/** Infer GADM level from GID (ESP → 0, ESP.9_1 → 1, ESP.9.20_1 → 2). */
export declare function levelFromGid(gid: string): number;
/**
 * Parent admin code for names lookup (exported helper; neighbors use rtree now).
 * ESP.9.20_1 → ESP.9_1; ESP.9_1 → ESP; ESP → null.
 */
export declare function parentAdminGid(gid: string): string | null;
/**
 * Return same-level regions that share a border with `gid` (direct neighbors only).
 */
export declare function getNeighbors(opts: NeighborsOptions): Promise<NeighborsResult>;
