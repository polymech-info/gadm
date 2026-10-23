/**
 * Display-oriented boundary cleanup for MapLibre / map caches.
 *
 * - Strip interior rings (optional): GADM lakes become dense stroke holes.
 * - Drop outer islands whose bbox min width is under ~5 km (keep largest part).
 * - Remove coastline “V” spikes (3-vertex folds) and small harbour ears.
 * Scale thresholds from each ring’s bbox so L0 and L1 share one rule set.
 * Long fjords keep long legs and are preserved.
 *
 * Does not use booleanValid / buffer(0) / convex-hull fallbacks.
 * Keep in sync with pm-pics `src/modules/places/utils/simplify-boundary.ts`.
 */

/** Default: ignore outer islands narrower than this (bbox min side). */
export const MIN_OUTER_ISLAND_WIDTH_KM = 5;

const KM_PER_DEG_LAT = 111.32;

export type CoastSmoothOpts = {
    maxTipDeg?: number;
    maxLegFrac?: number;
    minLegDeg?: number;
    minDetour?: number;
    maxEarAreaFrac?: number;
    maxPasses?: number;
};

export type MapSimplifyOpts = CoastSmoothOpts & {
    /** @deprecated Unused — MapLibre tolerance owns ring density. Kept for API compat. */
    maxRingPts?: number;
    /** @deprecated Unused — prefer minOuterWidthKm. Kept for API compat. */
    areaFraction?: number;
    /** @deprecated Unused — prefer minOuterWidthKm. Kept for API compat. */
    maxParts?: number;
    /**
     * Drop MultiPolygon outer parts whose bbox min width is below this (km).
     * Largest part is always kept. Default 5; `0` disables.
     */
    minOuterWidthKm?: number;
    keepHoles?: boolean;
    skipCoastSmooth?: boolean;
};

type Ring = number[][];

function closeRing(ring: Ring): Ring {
    if (!ring.length) return ring;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) return ring;
    return [...ring, [first[0], first[1]]];
}

function ringBbox(pts: Ring): { minx: number; miny: number; maxx: number; maxy: number } | null {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const c of pts) {
        if (!c || c.length < 2) continue;
        minx = Math.min(minx, c[0]);
        maxx = Math.max(maxx, c[0]);
        miny = Math.min(miny, c[1]);
        maxy = Math.max(maxy, c[1]);
    }
    if (![minx, miny, maxx, maxy].every(Number.isFinite)) return null;
    return { minx, miny, maxx, maxy };
}

function ringBboxDiag(pts: Ring): number {
    const b = ringBbox(pts);
    if (!b) return 1;
    return Math.hypot(b.maxx - b.minx, b.maxy - b.miny) || 1;
}

function ringAreaAbs(ring: Ring): number {
    if (!ring || ring.length < 4) return 0;
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    return Math.abs(a / 2);
}

/** Smaller bbox side in km (lon scaled by cos(mid-lat)). */
export function ringMinWidthKm(ring: Ring): number {
    const b = ringBbox(ring);
    if (!b) return 0;
    const midLat = (b.miny + b.maxy) / 2;
    const cos = Math.max(0.01, Math.cos((midLat * Math.PI) / 180));
    const widthKm = (b.maxx - b.minx) * KM_PER_DEG_LAT * cos;
    const heightKm = (b.maxy - b.miny) * KM_PER_DEG_LAT;
    return Math.min(widthKm, heightKm);
}

/**
 * Drop small outer islands from MultiPolygon / collections.
 * Always keeps the largest exterior (by area) so Monaco / city-states still paint.
 */
export function dropSmallOuterIslands(
    geometry: GeoJSON.Geometry | null | undefined,
    minWidthKm: number = MIN_OUTER_ISLAND_WIDTH_KM,
): GeoJSON.Geometry | null {
    if (!geometry) return null;
    if (!(minWidthKm > 0)) return geometry;

    if (geometry.type === 'Polygon') {
        const exterior = geometry.coordinates?.[0];
        if (!exterior || exterior.length < 4) return null;
        return geometry;
    }

    if (geometry.type === 'MultiPolygon') {
        const scored = (geometry.coordinates || [])
            .map((poly) => {
                const exterior = poly?.[0] as Ring | undefined;
                if (!exterior || exterior.length < 4) return null;
                return { poly, exterior, area: ringAreaAbs(exterior) };
            })
            .filter((p): p is { poly: GeoJSON.Position[][]; exterior: Ring; area: number } => !!p)
            .sort((a, b) => b.area - a.area);

        if (!scored.length) return null;

        const kept: GeoJSON.Position[][][] = [];
        for (let i = 0; i < scored.length; i++) {
            const { poly, exterior } = scored[i];
            if (i === 0 || ringMinWidthKm(exterior) >= minWidthKm) {
                kept.push(poly);
            }
        }
        if (!kept.length) return null;
        if (kept.length === 1) {
            return { type: 'Polygon', coordinates: kept[0] };
        }
        return { type: 'MultiPolygon', coordinates: kept };
    }

    if (geometry.type === 'GeometryCollection') {
        const geoms = (geometry.geometries || [])
            .map((g) => dropSmallOuterIslands(g, minWidthKm))
            .filter((g): g is GeoJSON.Geometry => !!g);
        if (!geoms.length) return null;
        if (geoms.length === 1) return geoms[0];
        return { type: 'GeometryCollection', geometries: geoms };
    }

    return geometry;
}

/** Drop 3-vertex V-spikes and small harbour ears on a closed ring. */
export function smoothCoastRing(ring: Ring, opts: CoastSmoothOpts = {}): Ring {
    const maxTipDeg = opts.maxTipDeg ?? 42;
    const maxLegFrac = opts.maxLegFrac ?? 0.04;
    const minLegDeg = opts.minLegDeg ?? 0.002;
    const minDetour = opts.minDetour ?? 1.12;
    const maxEarAreaFrac = opts.maxEarAreaFrac ?? 2.5e-5;
    const maxPasses = opts.maxPasses ?? 8;

    if (!ring || ring.length < 4) return closeRing(ring || []);
    let pts = ring.slice(0, -1);
    if (pts.length < 3) return closeRing(ring);

    const diag = ringBboxDiag(pts);
    const maxLeg = Math.max(diag * maxLegFrac, minLegDeg);
    const maxEarArea = diag * diag * maxEarAreaFrac;
    const cosTip = Math.cos((maxTipDeg * Math.PI) / 180);

    for (let pass = 0; pass < maxPasses; pass++) {
        const n = pts.length;
        if (n < 4) break;
        const keep = new Array(n).fill(true);
        let passRemoved = 0;

        for (let i = 0; i < n; i++) {
            const i0 = (i - 1 + n) % n;
            const i2 = (i + 1) % n;
            if (!keep[i0] || !keep[i2]) continue;

            const a = pts[i0];
            const b = pts[i];
            const c = pts[i2];
            const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
            const ac = Math.hypot(c[0] - a[0], c[1] - a[1]);
            if (ab < 1e-15 || bc < 1e-15) {
                keep[i] = false;
                passRemoved++;
                continue;
            }

            const ux = (a[0] - b[0]) / ab;
            const uy = (a[1] - b[1]) / ab;
            const vx = (c[0] - b[0]) / bc;
            const vy = (c[1] - b[1]) / bc;
            const cos = Math.max(-1, Math.min(1, ux * vx + uy * vy));
            const triArea =
                Math.abs(a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])) / 2;
            const detour = ac > 1e-15 ? (ab + bc) / ac : Infinity;
            const shortLegs = ab <= maxLeg && bc <= maxLeg;

            const isSpike = cos >= cosTip && shortLegs && detour >= minDetour;
            const isEar =
                shortLegs && triArea <= maxEarArea && detour >= 1.05 && cos > -0.15;

            if (isSpike || isEar) {
                keep[i] = false;
                passRemoved++;
            }
        }

        if (!passRemoved) break;
        const next: Ring = [];
        for (let i = 0; i < n; i++) if (keep[i]) next.push(pts[i]);
        if (next.length < 3) break;
        pts = next;
    }

    return closeRing(pts);
}

function smoothPolygonCoords(coords: Ring[], opts: CoastSmoothOpts): Ring[] {
    if (!coords?.length) return coords;
    const out: Ring[] = [smoothCoastRing(coords[0] as Ring, opts)];
    for (let i = 1; i < coords.length; i++) {
        out.push(smoothCoastRing(coords[i] as Ring, opts));
    }
    return out;
}

export function smoothCoastGeometry(
    geometry: GeoJSON.Geometry,
    opts: CoastSmoothOpts = {},
): GeoJSON.Geometry {
    if (geometry.type === 'Polygon') {
        return {
            type: 'Polygon',
            coordinates: smoothPolygonCoords(geometry.coordinates as Ring[], opts),
        };
    }
    if (geometry.type === 'MultiPolygon') {
        return {
            type: 'MultiPolygon',
            coordinates: (geometry.coordinates as Ring[][]).map((poly) =>
                smoothPolygonCoords(poly, opts),
            ),
        };
    }
    if (geometry.type === 'GeometryCollection') {
        return {
            type: 'GeometryCollection',
            geometries: (geometry.geometries || []).map((g) => smoothCoastGeometry(g, opts)),
        };
    }
    return geometry;
}

export function stripInteriorRings(geometry: GeoJSON.Geometry | null | undefined): GeoJSON.Geometry | null {
    if (!geometry) return null;
    if (geometry.type === 'Polygon') {
        const exterior = geometry.coordinates?.[0];
        if (!exterior || exterior.length < 4) return null;
        return { type: 'Polygon', coordinates: [exterior] };
    }
    if (geometry.type === 'MultiPolygon') {
        const parts: GeoJSON.Position[][][] = [];
        for (const poly of geometry.coordinates || []) {
            const exterior = poly?.[0];
            if (!exterior || exterior.length < 4) continue;
            parts.push([exterior]);
        }
        if (parts.length === 0) return null;
        if (parts.length === 1) return { type: 'Polygon', coordinates: parts[0] };
        return { type: 'MultiPolygon', coordinates: parts };
    }
    if (geometry.type === 'GeometryCollection') {
        const geoms = (geometry.geometries || [])
            .map((g) => stripInteriorRings(g))
            .filter((g): g is GeoJSON.Geometry => !!g);
        if (!geoms.length) return null;
        if (geoms.length === 1) return geoms[0];
        return { type: 'GeometryCollection', geometries: geoms };
    }
    return geometry;
}

/** True when FC was already display-cleaned (server or client). */
export function isMapPaintReady(
    input: GeoJSON.FeatureCollection | { features?: GeoJSON.Feature[]; _mapPaint?: boolean } | null | undefined,
): boolean {
    return !!(input && (input as { _mapPaint?: boolean })._mapPaint === true);
}

/** Map / cache FeatureCollection: hole strip + small-island drop + coast smooth. */
export function prepareBoundaryForMap(
    input: GeoJSON.FeatureCollection | { type?: string; features?: GeoJSON.Feature[]; _mapPaint?: boolean },
    opts: MapSimplifyOpts = {},
): GeoJSON.FeatureCollection {
    const featuresIn = Array.isArray(input?.features) ? input.features! : [];
    // Critical: zoom/prefetch storms call simplify=map on already-baked caches.
    // Re-running coast smooth on the main thread freezes Node (gridsearch/health hang).
    if (isMapPaintReady(input)) {
        return {
            type: 'FeatureCollection',
            features: featuresIn,
            _mapPaint: true,
        } as GeoJSON.FeatureCollection;
    }

    const keepHoles = opts.keepHoles === true;
    const skipCoast = opts.skipCoastSmooth === true;
    const minOuterKm =
        typeof opts.minOuterWidthKm === 'number' ? opts.minOuterWidthKm : MIN_OUTER_ISLAND_WIDTH_KM;
    const features: GeoJSON.Feature[] = [];

    for (const f of featuresIn) {
        if (!f?.geometry) continue;
        let geom: GeoJSON.Geometry | null = keepHoles ? f.geometry : stripInteriorRings(f.geometry);
        if (!geom) continue;
        geom = dropSmallOuterIslands(geom, minOuterKm);
        if (!geom) continue;
        if (!skipCoast) geom = smoothCoastGeometry(geom, opts);
        features.push({
            type: 'Feature',
            ...(f.id !== undefined ? { id: f.id } : {}),
            properties: { ...(f.properties || {}) },
            geometry: geom,
        });
    }

    return { type: 'FeatureCollection', features, _mapPaint: true } as GeoJSON.FeatureCollection;
}

/** @deprecated Prefer prepareBoundaryForMap */
export function simplifyBoundaryForMap(
    input: GeoJSON.FeatureCollection | { type?: string; features?: GeoJSON.Feature[] },
    opts: MapSimplifyOpts = {},
): GeoJSON.FeatureCollection {
    return prepareBoundaryForMap(input, opts);
}
