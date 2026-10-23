/**
 * Same-level geographic neighbors for a GADM region.
 *
 * Candidates come from the GeoPackage rtree at the requested level (all countries),
 * then a shared-border geometry filter keeps direct neighbors only.
 *
 * Results are file-cached when the pass completes without outline load failures.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as turf from '@turf/turf';
import {
    getBoundaryFromGpkg,
    queryUniqueGidsInBbox,
    type GadmCache,
    type BoundaryFeature,
} from './gpkg-reader.js';

type BBox4 = [number, number, number, number];

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);
const LOCAL_CACHE_DIR = join(_dirname, '../cache/gadm');
const CACHE_DIR = process.env.GADM_CACHE || LOCAL_CACHE_DIR;

/**
 * Max gap along a shared *border line* still counted as adjacent (meters).
 * Applied to boundary polylines only — not a fill buffer (that caused 2-hop hits).
 */
const BORDER_GAP_METERS = 100;
/** L0 uses coarsened outlines — slightly looser gap so micro-states (MCO) still match. */
const BORDER_GAP_METERS_L0 = 2500;
/** Exterior ring target size after decimation (adjacency only; not for display). */
const ADJACENCY_MAX_RING_PTS = 160;
const ADJACENCY_MAX_PARTS = 4;

const DEBUG = process.env.GADM_NEIGHBORS_DEBUG === '1';
const LOG = (...args: unknown[]) => {
    if (DEBUG) console.log('[gadm:neighbors]', ...args);
};

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

export type NeighborsResult =
    | { data: NeighborRegion[] }
    | { error: string };

function cacheKey(gid: string, level: number): string {
    const safe = gid.replace(/[^a-zA-Z0-9\.\-_]/g, '_').substring(0, 50);
    // v6: rtree candidates; never cache empty/incomplete (startup race left empty v5 files)
    return `neighbors_v6_${safe}_L${level}`;
}

function cachePath(key: string): string {
    return join(CACHE_DIR, `${key}.json`);
}

async function readCache(key: string, extCache?: GadmCache): Promise<NeighborsResult | null> {
    if (extCache) {
        try {
            const cached = await extCache.get(key);
            if (cached) return cached as NeighborsResult;
        } catch { /* ignore */ }
        return null;
    }
    const path = cachePath(key);
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8')) as NeighborsResult;
    } catch {
        return null;
    }
}

async function writeCache(key: string, data: NeighborsResult, extCache?: GadmCache): Promise<void> {
    if (extCache) {
        try { await extCache.set(key, data); } catch { /* ignore */ }
        return;
    }
    const path = cachePath(key);
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(data));
    } catch (e) {
        console.error('[gadm:neighbors] cache write failed:', e);
    }
}

/** Infer GADM level from GID (ESP → 0, ESP.9_1 → 1, ESP.9.20_1 → 2). */
export function levelFromGid(gid: string): number {
    const base = gid.replace(/_\d+$/, '');
    if (!base.includes('.')) return 0;
    return base.split('.').length - 1;
}

/**
 * Parent admin code for names lookup (exported helper; neighbors use rtree now).
 * ESP.9.20_1 → ESP.9_1; ESP.9_1 → ESP; ESP → null.
 */
export function parentAdminGid(gid: string): string | null {
    const versionMatch = gid.match(/_(\d+)$/);
    const versionSuffix = versionMatch ? `_${versionMatch[1]}` : '_1';
    const base = gid.replace(/_\d+$/, '');
    const parts = base.split('.');
    if (parts.length <= 1) return null;
    parts.pop();
    if (parts.length === 1) return parts[0];
    return parts.join('.') + versionSuffix;
}

function gidNorm(gid: string): string {
    return gid.replace(/_\d+$/, '');
}

/** Relative bbox expand — better than fixed degrees at high latitudes / small units. */
function expandBboxRelative(b: BBox4, fraction = 0.15, minDeg = 0.05): BBox4 {
    const spanLng = Math.max(minDeg, b[2] - b[0]);
    const spanLat = Math.max(minDeg, b[3] - b[1]);
    const padLng = Math.max(minDeg, spanLng * fraction);
    const padLat = Math.max(minDeg, spanLat * fraction);
    return [b[0] - padLng, b[1] - padLat, b[2] + padLng, b[3] + padLat];
}

function lngSpan(b: BBox4): number {
    return b[2] - b[0];
}

/** AABB that crosses the antimeridian spans >180° and overlaps almost everything. */
function isAntimeridianBbox(b: BBox4): boolean {
    return lngSpan(b) > 180;
}

function bboxOverlaps(a: BBox4, b: BBox4, padFraction = 0.02): boolean {
    // Kiribati-style MultiPolygons get a world-spanning AABB (−174…176). That falsely
    // overlaps Kenya/etc. Reject wrapping candidate boxes; if the *target* wraps, only
    // require latitude overlap and let geometry decide.
    const wrapA = isAntimeridianBbox(a);
    const wrapB = isAntimeridianBbox(b);
    if (wrapB && !wrapA) return false;
    if (wrapA && wrapB) return true;

    const spanLng = Math.max(0.01, a[2] - a[0]);
    const spanLat = Math.max(0.01, a[3] - a[1]);
    const padLng = wrapA ? 0 : spanLng * padFraction;
    const padLat = spanLat * padFraction;

    if (wrapA) {
        // Target wraps: longitude AABB is meaningless — latitude gate only.
        return !(a[3] + padLat < b[1] || a[1] - padLat > b[3]);
    }

    return !(
        a[2] + padLng < b[0] ||
        a[0] - padLng > b[2] ||
        a[3] + padLat < b[1] ||
        a[1] - padLat > b[3]
    );
}

function asBBox4(b: number[]): BBox4 {
    return [b[0], b[1], b[2], b[3]];
}

function fmtBbox(b: BBox4): number[] {
    return b.map((n) => Number(n.toFixed(4)));
}

function toLineFc(feature: BoundaryFeature): any | null {
    try {
        const line = turf.polygonToLine(feature as any);
        if (!line) return null;
        if (line.type === 'FeatureCollection') return line;
        return turf.featureCollection([line]);
    } catch (e) {
        LOG('toLineFc failed', (e as Error)?.message);
        return null;
    }
}

function decimateRing(ring: number[][], maxPts: number): number[][] {
    if (!ring || ring.length <= maxPts) return ring;
    const step = Math.max(1, Math.ceil((ring.length - 1) / maxPts));
    const out: number[][] = [];
    for (let i = 0; i < ring.length - 1; i += step) out.push(ring[i]);
    const first = out[0];
    const last = out[out.length - 1];
    if (!last || first[0] !== last[0] || first[1] !== last[1]) {
        out.push([first[0], first[1]]);
    }
    return out.length >= 4 ? out : ring;
}

/**
 * Adjacency-only geometry: keep ~98% area by largest parts, drop holes/islands,
 * decimate exterior rings. Full-res country MultiPolygons (FRA ~11k pts × 400 parts)
 * make turf line/buffer checks take minutes and block the Node event loop.
 */
function coarsenForAdjacency(
    feature: BoundaryFeature,
    maxPts = ADJACENCY_MAX_RING_PTS,
    maxParts = ADJACENCY_MAX_PARTS,
): BoundaryFeature {
    const g = feature.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return feature;

    type Ring = number[][];
    type PolyCoords = Ring[];
    const polys: PolyCoords[] = g.type === 'Polygon'
        ? [g.coordinates as PolyCoords]
        : (g.coordinates as PolyCoords[]);
    const scored = polys.map((coordinates) => {
        const exterior = coordinates[0] as Ring;
        let area = 0;
        try {
            area = turf.area({
                type: 'Feature',
                properties: {},
                geometry: { type: 'Polygon', coordinates: [exterior] },
            } as any);
        } catch { /* ignore */ }
        return { ring: exterior, area };
    }).sort((a, b) => b.area - a.area);

    if (scored.length === 0) return feature;
    const total = scored.reduce((s, x) => s + x.area, 0) || 1;
    const kept: PolyCoords[] = [];
    let acc = 0;
    for (const p of scored) {
        if (!p.ring?.length) continue;
        kept.push([decimateRing(p.ring, maxPts)]);
        acc += p.area;
        if (acc / total >= 0.98 || kept.length >= maxParts) break;
    }
    if (kept.length === 0) return feature;
    if (kept.length === 1) {
        return {
            type: 'Feature',
            properties: { ...(feature.properties || {}) },
            geometry: { type: 'Polygon', coordinates: kept[0] },
        };
    }
    return {
        type: 'Feature',
        properties: { ...(feature.properties || {}) },
        geometry: { type: 'MultiPolygon', coordinates: kept },
    };
}

function needsAdjacencyCoarsen(feature: BoundaryFeature, level: number): boolean {
    if (level === 0) return true;
    const g = feature.geometry;
    if (!g) return false;
    if (g.type === 'Polygon') return (g.coordinates?.[0]?.length || 0) > 2500;
    if (g.type === 'MultiPolygon') {
        if (g.coordinates.length > 20) return true;
        return g.coordinates.some((p: number[][][]) => (p?.[0]?.length || 0) > 2500);
    }
    return false;
}

/**
 * Direct neighbors only: shared border (or within gapMeters along the edge).
 * Does NOT buffer the polygon fill — that pulled in 2-hop regions for small units.
 */
function isMultiPolygonFeature(f: BoundaryFeature): boolean {
    return f?.geometry?.type === 'MultiPolygon';
}

function sharesBorder(
    a: BoundaryFeature,
    b: BoundaryFeature,
    debugLabel?: string,
    gapMeters: number = BORDER_GAP_METERS,
): boolean {
    // turf.booleanTouches blows up on some MultiPolygons ("coord.coordinates is not iterable")
    // e.g. KEN↔KIR — skip touches and use boundary lines instead.
    const skipTouches = isMultiPolygonFeature(a) || isMultiPolygonFeature(b);
    if (!skipTouches) {
        try {
            if (turf.booleanTouches(a as any, b as any)) {
                if (debugLabel) LOG('sharesBorder touches', debugLabel);
                return true;
            }
        } catch (e) {
            LOG('booleanTouches threw', debugLabel, (e as Error)?.message);
        }
    }

    const linesA = toLineFc(a);
    const linesB = toLineFc(b);
    if (!linesA || !linesB) {
        if (debugLabel) LOG('sharesBorder no lines', debugLabel, { linesA: !!linesA, linesB: !!linesB });
        return false;
    }

    try {
        if (turf.booleanIntersects(linesA as any, linesB as any)) {
            if (debugLabel) LOG('sharesBorder lineIntersect', debugLabel);
            return true;
        }
    } catch (e) {
        LOG('lineIntersect threw', debugLabel, (e as Error)?.message);
    }

    try {
        const buffered = turf.buffer(linesA as any, gapMeters, { units: 'meters' });
        if (buffered && turf.booleanIntersects(buffered as any, linesB as any)) {
            if (debugLabel) LOG('sharesBorder edgeBuffer', debugLabel, `${gapMeters}m`);
            return true;
        }
    } catch (e) {
        LOG('edgeBuffer threw', debugLabel, (e as Error)?.message);
    }

    return false;
}

function yieldEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Preserve all polygon parts as a MultiPolygon.
 * Adjacency does not require dissolving — never silently keep only features[0].
 */
function mergeFeatures(features: BoundaryFeature[]): BoundaryFeature | null {
    if (!features.length) return null;
    if (features.length === 1) return features[0];

    const coords: any[] = [];
    for (const f of features) {
        const g = f.geometry;
        if (!g) continue;
        if (g.type === 'Polygon') coords.push(g.coordinates);
        else if (g.type === 'MultiPolygon') coords.push(...g.coordinates);
    }
    if (coords.length === 0) return null;

    return {
        type: 'Feature',
        properties: { ...(features[0].properties || {}) },
        geometry: { type: 'MultiPolygon', coordinates: coords },
    };
}

/** Load the region's own outline at its native GID level. */
async function loadOutline(gid: string, cache?: GadmCache): Promise<{
    feature: BoundaryFeature;
    bbox: BBox4;
} | null> {
    const nativeLevel = levelFromGid(gid);
    const result = await getBoundaryFromGpkg(gid, nativeLevel, cache);
    if (!result?.features?.length) {
        LOG('loadOutline miss', { gid, nativeLevel });
        return null;
    }
    const feature = mergeFeatures(result.features);
    if (!feature?.geometry) {
        LOG('loadOutline merge failed', { gid, featureCount: result.features.length });
        return null;
    }
    try {
        const bbox = asBBox4(turf.bbox(feature as any));
        LOG('loadOutline ok', {
            gid,
            nativeLevel,
            featureCount: result.features.length,
            geom: feature.geometry.type,
            bbox: fmtBbox(bbox),
        });
        return { feature, bbox };
    } catch (e) {
        LOG('loadOutline bbox failed', gid, (e as Error)?.message);
        return null;
    }
}

/**
 * Spatial candidates at `level` from the gpkg rtree (all countries / parents).
 * Sibling-only lists miss cross-province / cross-border neighbors.
 */
function candidateList(
    gid: string,
    level: number,
    targetBbox: BBox4,
): Array<{ gid: string; gadmName: string }> {
    const expanded = expandBboxRelative(targetBbox, 0.2, 0.05);
    LOG('candidateList', {
        gid,
        level,
        targetBbox: fmtBbox(targetBbox),
        expanded: fmtBbox(expanded),
    });

    const hits = queryUniqueGidsInBbox(expanded, level);
    const self = gidNorm(gid);
    const seen = new Set<string>();
    const out: Array<{ gid: string; gadmName: string }> = [];
    let skippedLevel = 0;
    let skippedSelf = 0;

    for (const h of hits) {
        if (!h?.gid || typeof h.gid !== 'string') continue;
        const hitLevel = levelFromGid(h.gid);
        if (hitLevel !== level) {
            skippedLevel += 1;
            continue;
        }
        const key = gidNorm(h.gid);
        if (key === self || seen.has(key)) {
            skippedSelf += 1;
            continue;
        }
        seen.add(key);
        out.push({ gid: h.gid, gadmName: h.name || h.gid });
    }

    LOG('candidateList result', {
        gid,
        level,
        rtreeHits: hits.length,
        afterFilter: out.length,
        skippedLevel,
        skippedSelf,
        sample: out.slice(0, 12).map((c) => `${c.gadmName}(${c.gid})`),
    });
    return out;
}

/**
 * Return same-level regions that share a border with `gid` (direct neighbors only).
 */
export async function getNeighbors(opts: NeighborsOptions): Promise<NeighborsResult> {
    const t0 = Date.now();
    const gid = (opts.gid || '').trim();
    if (!gid) return { error: 'gid is required' };

    const level = opts.level != null ? opts.level : levelFromGid(gid);
    if (level < 0 || level > 5) return { error: 'level must be 0–5' };

    LOG('getNeighbors start', { gid, level, inferred: levelFromGid(gid), optsLevel: opts.level });

    const key = cacheKey(gid, level);
    const cached = await readCache(key, opts.cache);
    if (cached) {
        const n = 'data' in cached ? cached.data.length : -1;
        LOG('getNeighbors cache hit', { key, count: n, ms: Date.now() - t0 });
        return cached;
    }

    try {
        const target = await loadOutline(gid, opts.cache);
        if (!target) {
            LOG('getNeighbors abort: no target outline', gid);
            return { error: `Boundary not found for ${gid}` };
        }

        const coarsenTarget = needsAdjacencyCoarsen(target.feature, level);
        const targetAdj = coarsenTarget ? coarsenForAdjacency(target.feature) : target.feature;
        let targetBbox = target.bbox;
        if (coarsenTarget) {
            try {
                targetBbox = asBBox4(turf.bbox(targetAdj as any));
            } catch { /* keep full bbox */ }
        }
        const borderGap = level === 0 ? BORDER_GAP_METERS_L0 : BORDER_GAP_METERS;

        const candidates = candidateList(gid, level, targetBbox);
        if (candidates.length === 0) {
            LOG('getNeighbors no candidates — check gpkg/rtree', { gid, level, bbox: fmtBbox(targetBbox) });
        }

        const neighbors: NeighborRegion[] = [];
        let outlineFailures = 0;
        let rejectedBbox = 0;
        let rejectedBorder = 0;
        const rejectedBorderSample: string[] = [];

        for (const c of candidates) {
            // Country-level geometry checks are CPU-heavy; yield so boundary/names/tree stay responsive.
            await yieldEventLoop();

            const outline = await loadOutline(c.gid, opts.cache);
            if (!outline) {
                outlineFailures += 1;
                continue;
            }
            const otherAdj = needsAdjacencyCoarsen(outline.feature, level)
                ? coarsenForAdjacency(outline.feature)
                : outline.feature;
            let otherBbox = outline.bbox;
            if (otherAdj !== outline.feature) {
                try {
                    otherBbox = asBBox4(turf.bbox(otherAdj as any));
                } catch { /* keep */ }
            }
            if (!bboxOverlaps(targetBbox, otherBbox)) {
                rejectedBbox += 1;
                continue;
            }
            if (!sharesBorder(targetAdj, otherAdj, `${gid}↔${c.gid}`, borderGap)) {
                rejectedBorder += 1;
                if (rejectedBorderSample.length < 8) {
                    rejectedBorderSample.push(`${c.gadmName}(${c.gid})`);
                }
                continue;
            }

            let lng: number | undefined;
            let lat: number | undefined;
            try {
                const coid = turf.centroid(otherAdj as any);
                const coords = coid?.geometry?.coordinates;
                if (coords && coords.length >= 2) {
                    lng = coords[0];
                    lat = coords[1];
                }
            } catch { /* ignore */ }

            neighbors.push({
                gid: c.gid,
                gadmName: c.gadmName,
                level,
                lng,
                lat,
            });
            LOG('accepted neighbor', { from: gid, to: c.gid, name: c.gadmName, lng, lat });
        }

        neighbors.sort((a, b) => a.gadmName.localeCompare(b.gadmName));
        const result: NeighborsResult = { data: neighbors };

        LOG('getNeighbors done', {
            gid,
            level,
            candidates: candidates.length,
            neighbors: neighbors.length,
            outlineFailures,
            rejectedBbox,
            rejectedBorder,
            rejectedBorderSample,
            names: neighbors.map((n) => n.gadmName),
            ms: Date.now() - t0,
            cached: outlineFailures === 0,
        });

        // Do not cache incomplete or empty passes — empty often means rtree/gpkg not ready yet.
        if (outlineFailures === 0 && neighbors.length > 0) {
            await writeCache(key, result, opts.cache);
        } else if (outlineFailures > 0) {
            console.warn(
                `[gadm:neighbors] getNeighbors(${gid}): ${outlineFailures}/${candidates.length} candidate outlines failed — not caching`,
            );
        } else if (neighbors.length === 0) {
            LOG('getNeighbors empty — not caching', { gid, level, candidates: candidates.length });
        }

        return result;
    } catch (e: any) {
        console.error('[gadm:neighbors] getNeighbors threw', gid, e);
        return { error: e?.message || String(e) };
    }
}
