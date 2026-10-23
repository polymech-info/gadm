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
import { getBoundaryFromGpkg, queryUniqueGidsInBbox, } from './gpkg-reader.js';
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
const LOG = (...args) => {
    if (DEBUG)
        console.log('[gadm:neighbors]', ...args);
};
function cacheKey(gid, level) {
    const safe = gid.replace(/[^a-zA-Z0-9\.\-_]/g, '_').substring(0, 50);
    // v6: rtree candidates; never cache empty/incomplete (startup race left empty v5 files)
    return `neighbors_v6_${safe}_L${level}`;
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
        catch { /* ignore */ }
        return null;
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
        catch { /* ignore */ }
        return;
    }
    const path = cachePath(key);
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(data));
    }
    catch (e) {
        console.error('[gadm:neighbors] cache write failed:', e);
    }
}
/** Infer GADM level from GID (ESP → 0, ESP.9_1 → 1, ESP.9.20_1 → 2). */
export function levelFromGid(gid) {
    const base = gid.replace(/_\d+$/, '');
    if (!base.includes('.'))
        return 0;
    return base.split('.').length - 1;
}
/**
 * Parent admin code for names lookup (exported helper; neighbors use rtree now).
 * ESP.9.20_1 → ESP.9_1; ESP.9_1 → ESP; ESP → null.
 */
export function parentAdminGid(gid) {
    const versionMatch = gid.match(/_(\d+)$/);
    const versionSuffix = versionMatch ? `_${versionMatch[1]}` : '_1';
    const base = gid.replace(/_\d+$/, '');
    const parts = base.split('.');
    if (parts.length <= 1)
        return null;
    parts.pop();
    if (parts.length === 1)
        return parts[0];
    return parts.join('.') + versionSuffix;
}
function gidNorm(gid) {
    return gid.replace(/_\d+$/, '');
}
/** Relative bbox expand — better than fixed degrees at high latitudes / small units. */
function expandBboxRelative(b, fraction = 0.15, minDeg = 0.05) {
    const spanLng = Math.max(minDeg, b[2] - b[0]);
    const spanLat = Math.max(minDeg, b[3] - b[1]);
    const padLng = Math.max(minDeg, spanLng * fraction);
    const padLat = Math.max(minDeg, spanLat * fraction);
    return [b[0] - padLng, b[1] - padLat, b[2] + padLng, b[3] + padLat];
}
function lngSpan(b) {
    return b[2] - b[0];
}
/** AABB that crosses the antimeridian spans >180° and overlaps almost everything. */
function isAntimeridianBbox(b) {
    return lngSpan(b) > 180;
}
function bboxOverlaps(a, b, padFraction = 0.02) {
    // Kiribati-style MultiPolygons get a world-spanning AABB (−174…176). That falsely
    // overlaps Kenya/etc. Reject wrapping candidate boxes; if the *target* wraps, only
    // require latitude overlap and let geometry decide.
    const wrapA = isAntimeridianBbox(a);
    const wrapB = isAntimeridianBbox(b);
    if (wrapB && !wrapA)
        return false;
    if (wrapA && wrapB)
        return true;
    const spanLng = Math.max(0.01, a[2] - a[0]);
    const spanLat = Math.max(0.01, a[3] - a[1]);
    const padLng = wrapA ? 0 : spanLng * padFraction;
    const padLat = spanLat * padFraction;
    if (wrapA) {
        // Target wraps: longitude AABB is meaningless — latitude gate only.
        return !(a[3] + padLat < b[1] || a[1] - padLat > b[3]);
    }
    return !(a[2] + padLng < b[0] ||
        a[0] - padLng > b[2] ||
        a[3] + padLat < b[1] ||
        a[1] - padLat > b[3]);
}
function asBBox4(b) {
    return [b[0], b[1], b[2], b[3]];
}
function fmtBbox(b) {
    return b.map((n) => Number(n.toFixed(4)));
}
function toLineFc(feature) {
    try {
        const line = turf.polygonToLine(feature);
        if (!line)
            return null;
        if (line.type === 'FeatureCollection')
            return line;
        return turf.featureCollection([line]);
    }
    catch (e) {
        LOG('toLineFc failed', e?.message);
        return null;
    }
}
function decimateRing(ring, maxPts) {
    if (!ring || ring.length <= maxPts)
        return ring;
    const step = Math.max(1, Math.ceil((ring.length - 1) / maxPts));
    const out = [];
    for (let i = 0; i < ring.length - 1; i += step)
        out.push(ring[i]);
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
function coarsenForAdjacency(feature, maxPts = ADJACENCY_MAX_RING_PTS, maxParts = ADJACENCY_MAX_PARTS) {
    const g = feature.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon'))
        return feature;
    const polys = g.type === 'Polygon'
        ? [g.coordinates]
        : g.coordinates;
    const scored = polys.map((coordinates) => {
        const exterior = coordinates[0];
        let area = 0;
        try {
            area = turf.area({
                type: 'Feature',
                properties: {},
                geometry: { type: 'Polygon', coordinates: [exterior] },
            });
        }
        catch { /* ignore */ }
        return { ring: exterior, area };
    }).sort((a, b) => b.area - a.area);
    if (scored.length === 0)
        return feature;
    const total = scored.reduce((s, x) => s + x.area, 0) || 1;
    const kept = [];
    let acc = 0;
    for (const p of scored) {
        if (!p.ring?.length)
            continue;
        kept.push([decimateRing(p.ring, maxPts)]);
        acc += p.area;
        if (acc / total >= 0.98 || kept.length >= maxParts)
            break;
    }
    if (kept.length === 0)
        return feature;
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
function needsAdjacencyCoarsen(feature, level) {
    if (level === 0)
        return true;
    const g = feature.geometry;
    if (!g)
        return false;
    if (g.type === 'Polygon')
        return (g.coordinates?.[0]?.length || 0) > 2500;
    if (g.type === 'MultiPolygon') {
        if (g.coordinates.length > 20)
            return true;
        return g.coordinates.some((p) => (p?.[0]?.length || 0) > 2500);
    }
    return false;
}
/**
 * Direct neighbors only: shared border (or within gapMeters along the edge).
 * Does NOT buffer the polygon fill — that pulled in 2-hop regions for small units.
 */
function isMultiPolygonFeature(f) {
    return f?.geometry?.type === 'MultiPolygon';
}
function sharesBorder(a, b, debugLabel, gapMeters = BORDER_GAP_METERS) {
    // turf.booleanTouches blows up on some MultiPolygons ("coord.coordinates is not iterable")
    // e.g. KEN↔KIR — skip touches and use boundary lines instead.
    const skipTouches = isMultiPolygonFeature(a) || isMultiPolygonFeature(b);
    if (!skipTouches) {
        try {
            if (turf.booleanTouches(a, b)) {
                if (debugLabel)
                    LOG('sharesBorder touches', debugLabel);
                return true;
            }
        }
        catch (e) {
            LOG('booleanTouches threw', debugLabel, e?.message);
        }
    }
    const linesA = toLineFc(a);
    const linesB = toLineFc(b);
    if (!linesA || !linesB) {
        if (debugLabel)
            LOG('sharesBorder no lines', debugLabel, { linesA: !!linesA, linesB: !!linesB });
        return false;
    }
    try {
        if (turf.booleanIntersects(linesA, linesB)) {
            if (debugLabel)
                LOG('sharesBorder lineIntersect', debugLabel);
            return true;
        }
    }
    catch (e) {
        LOG('lineIntersect threw', debugLabel, e?.message);
    }
    try {
        const buffered = turf.buffer(linesA, gapMeters, { units: 'meters' });
        if (buffered && turf.booleanIntersects(buffered, linesB)) {
            if (debugLabel)
                LOG('sharesBorder edgeBuffer', debugLabel, `${gapMeters}m`);
            return true;
        }
    }
    catch (e) {
        LOG('edgeBuffer threw', debugLabel, e?.message);
    }
    return false;
}
function yieldEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
}
/**
 * Preserve all polygon parts as a MultiPolygon.
 * Adjacency does not require dissolving — never silently keep only features[0].
 */
function mergeFeatures(features) {
    if (!features.length)
        return null;
    if (features.length === 1)
        return features[0];
    const coords = [];
    for (const f of features) {
        const g = f.geometry;
        if (!g)
            continue;
        if (g.type === 'Polygon')
            coords.push(g.coordinates);
        else if (g.type === 'MultiPolygon')
            coords.push(...g.coordinates);
    }
    if (coords.length === 0)
        return null;
    return {
        type: 'Feature',
        properties: { ...(features[0].properties || {}) },
        geometry: { type: 'MultiPolygon', coordinates: coords },
    };
}
/** Load the region's own outline at its native GID level. */
async function loadOutline(gid, cache) {
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
        const bbox = asBBox4(turf.bbox(feature));
        LOG('loadOutline ok', {
            gid,
            nativeLevel,
            featureCount: result.features.length,
            geom: feature.geometry.type,
            bbox: fmtBbox(bbox),
        });
        return { feature, bbox };
    }
    catch (e) {
        LOG('loadOutline bbox failed', gid, e?.message);
        return null;
    }
}
/**
 * Spatial candidates at `level` from the gpkg rtree (all countries / parents).
 * Sibling-only lists miss cross-province / cross-border neighbors.
 */
function candidateList(gid, level, targetBbox) {
    const expanded = expandBboxRelative(targetBbox, 0.2, 0.05);
    LOG('candidateList', {
        gid,
        level,
        targetBbox: fmtBbox(targetBbox),
        expanded: fmtBbox(expanded),
    });
    const hits = queryUniqueGidsInBbox(expanded, level);
    const self = gidNorm(gid);
    const seen = new Set();
    const out = [];
    let skippedLevel = 0;
    let skippedSelf = 0;
    for (const h of hits) {
        if (!h?.gid || typeof h.gid !== 'string')
            continue;
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
export async function getNeighbors(opts) {
    const t0 = Date.now();
    const gid = (opts.gid || '').trim();
    if (!gid)
        return { error: 'gid is required' };
    const level = opts.level != null ? opts.level : levelFromGid(gid);
    if (level < 0 || level > 5)
        return { error: 'level must be 0–5' };
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
                targetBbox = asBBox4(turf.bbox(targetAdj));
            }
            catch { /* keep full bbox */ }
        }
        const borderGap = level === 0 ? BORDER_GAP_METERS_L0 : BORDER_GAP_METERS;
        const candidates = candidateList(gid, level, targetBbox);
        if (candidates.length === 0) {
            LOG('getNeighbors no candidates — check gpkg/rtree', { gid, level, bbox: fmtBbox(targetBbox) });
        }
        const neighbors = [];
        let outlineFailures = 0;
        let rejectedBbox = 0;
        let rejectedBorder = 0;
        const rejectedBorderSample = [];
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
                    otherBbox = asBBox4(turf.bbox(otherAdj));
                }
                catch { /* keep */ }
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
            let lng;
            let lat;
            try {
                const coid = turf.centroid(otherAdj);
                const coords = coid?.geometry?.coordinates;
                if (coords && coords.length >= 2) {
                    lng = coords[0];
                    lat = coords[1];
                }
            }
            catch { /* ignore */ }
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
        const result = { data: neighbors };
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
        }
        else if (outlineFailures > 0) {
            console.warn(`[gadm:neighbors] getNeighbors(${gid}): ${outlineFailures}/${candidates.length} candidate outlines failed — not caching`);
        }
        else if (neighbors.length === 0) {
            LOG('getNeighbors empty — not caching', { gid, level, candidates: candidates.length });
        }
        return result;
    }
    catch (e) {
        console.error('[gadm:neighbors] getNeighbors threw', gid, e);
        return { error: e?.message || String(e) };
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmVpZ2hib3JzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL25laWdoYm9ycy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7OztHQU9HO0FBQ0gsT0FBTyxFQUFFLFVBQVUsRUFBRSxZQUFZLEVBQUUsYUFBYSxFQUFFLFNBQVMsRUFBRSxNQUFNLElBQUksQ0FBQztBQUN4RSxPQUFPLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxNQUFNLE1BQU0sQ0FBQztBQUNyQyxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sS0FBSyxDQUFDO0FBQ3BDLE9BQU8sS0FBSyxJQUFJLE1BQU0sWUFBWSxDQUFDO0FBQ25DLE9BQU8sRUFDSCxtQkFBbUIsRUFDbkIscUJBQXFCLEdBR3hCLE1BQU0sa0JBQWtCLENBQUM7QUFJMUIsTUFBTSxTQUFTLEdBQUcsYUFBYSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDakQsTUFBTSxRQUFRLEdBQUcsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBQ3BDLE1BQU0sZUFBZSxHQUFHLElBQUksQ0FBQyxRQUFRLEVBQUUsZUFBZSxDQUFDLENBQUM7QUFDeEQsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxVQUFVLElBQUksZUFBZSxDQUFDO0FBRTVEOzs7R0FHRztBQUNILE1BQU0saUJBQWlCLEdBQUcsR0FBRyxDQUFDO0FBQzlCLDBGQUEwRjtBQUMxRixNQUFNLG9CQUFvQixHQUFHLElBQUksQ0FBQztBQUNsQyxvRkFBb0Y7QUFDcEYsTUFBTSxzQkFBc0IsR0FBRyxHQUFHLENBQUM7QUFDbkMsTUFBTSxtQkFBbUIsR0FBRyxDQUFDLENBQUM7QUFFOUIsTUFBTSxLQUFLLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxvQkFBb0IsS0FBSyxHQUFHLENBQUM7QUFDdkQsTUFBTSxHQUFHLEdBQUcsQ0FBQyxHQUFHLElBQWUsRUFBRSxFQUFFO0lBQy9CLElBQUks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