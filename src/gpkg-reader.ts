/**
 * gpkg-reader.ts — Read geometry from a local GeoPackage file.
 *
 * Parses GeoPackage Binary (GPKG header + WKB) into GeoJSON.
 * Uses better-sqlite3 for SQLite access.
 *
 * GeoPackage Binary format:
 *   [2 bytes magic "GP"] [1 byte version] [1 byte flags]
 *   [4 bytes SRS ID] [envelope (0–64 bytes)] [WKB geometry]
 *
 * Flags byte: bit 0 = byte order, bits 1-3 = envelope type, bit 5 = empty
 * Envelope sizes: 0=none, 1=xy(32B), 2=xyz(48B), 3=xym(48B), 4=xyzm(64B)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'node:worker_threads';
import { enrichFeatureWithGHS } from './enrich-ghs.js';
import * as turf from '@turf/turf';
import { getNames } from './names.js';

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

// ────────── Types ──────────

export interface GeoJSONGeometry {
    type: string;
    coordinates: any;
}

export interface BoundaryFeature {
    type: 'Feature';
    properties: Record<string, any>;
    geometry: GeoJSONGeometry;
}

export interface BoundaryResult {
    type: 'FeatureCollection';
    features: BoundaryFeature[];
}

// ────────── GeoPackage paths ──────────

const DEFAULT_GPKG_PATHS = [
    // 1. Explicit environment-defined path
    process.env.GADM_GPKG_PATH,
    // 2. Package-local data (works regardless of process.cwd())
    resolve(_dirname, '../data/gadm_410.gpkg'),
    // 3. Production CWD data mount
    resolve(process.cwd(), 'data/gadm_410.gpkg'),
    resolve(process.cwd(), 'cache/gadm/gadm_410.gpkg'),
];

let _gpkgPath: string | null = null;

/** Set or override the GeoPackage file path */
export function setGpkgPath(p: string): void {
    _gpkgPath = p;
}

function findGpkg(): string | null {
    if (_gpkgPath && existsSync(_gpkgPath)) return _gpkgPath;
    for (const p of DEFAULT_GPKG_PATHS) {
        if (p && existsSync(p)) {
            _gpkgPath = p;
            return p;
        }
    }
    return null;
}

// ────────── WKB Parser ──────────

class WKBReader {
    private buf: Buffer;
    private pos: number;
    private le: boolean; // little-endian

    constructor(buf: Buffer, offset: number) {
        this.buf = buf;
        this.pos = offset;
        // First byte of WKB = endianness indicator
        this.le = this.buf[this.pos] === 1;
        this.pos++;
    }

    private readUInt32(): number {
        const v = this.le
            ? this.buf.readUInt32LE(this.pos)
            : this.buf.readUInt32BE(this.pos);
        this.pos += 4;
        return v;
    }

    private readDouble(): number {
        const v = this.le
            ? this.buf.readDoubleLE(this.pos)
            : this.buf.readDoubleBE(this.pos);
        this.pos += 8;
        return v;
    }

    private readCoord(): [number, number] {
        const x = this.readDouble(); // longitude
        const y = this.readDouble(); // latitude
        return [x, y];
    }

    private readRing(): [number, number][] {
        const count = this.readUInt32();
        const ring: [number, number][] = [];
        for (let i = 0; i < count; i++) {
            ring.push(this.readCoord());
        }
        return ring;
    }

    private readPolygon(): [number, number][][] {
        const ringCount = this.readUInt32();
        const rings: [number, number][][] = [];
        for (let i = 0; i < ringCount; i++) {
            rings.push(this.readRing());
        }
        return rings;
    }

    readGeometry(): GeoJSONGeometry {
        const wkbType = this.readUInt32();

        switch (wkbType) {
            case 1: // Point
                return { type: 'Point', coordinates: this.readCoord() };

            case 2: { // LineString
                const count = this.readUInt32();
                const coords: [number, number][] = [];
                for (let i = 0; i < count; i++) coords.push(this.readCoord());
                return { type: 'LineString', coordinates: coords };
            }

            case 3: // Polygon
                return { type: 'Polygon', coordinates: this.readPolygon() };

            case 4: { // MultiPoint
                const count = this.readUInt32();
                const points: [number, number][] = [];
                for (let i = 0; i < count; i++) {
                    this.le = this.buf[this.pos] === 1; this.pos++;
                    this.readUInt32(); // skip type
                    points.push(this.readCoord());
                }
                return { type: 'MultiPoint', coordinates: points };
            }

            case 5: { // MultiLineString
                const count = this.readUInt32();
                const lines: [number, number][][] = [];
                for (let i = 0; i < count; i++) {
                    this.le = this.buf[this.pos] === 1; this.pos++;
                    this.readUInt32(); // skip type
                    const ptCount = this.readUInt32();
                    const coords: [number, number][] = [];
                    for (let j = 0; j < ptCount; j++) coords.push(this.readCoord());
                    lines.push(coords);
                }
                return { type: 'MultiLineString', coordinates: lines };
            }

            case 6: { // MultiPolygon
                const count = this.readUInt32();
                const polys: [number, number][][][] = [];
                for (let i = 0; i < count; i++) {
                    this.le = this.buf[this.pos] === 1; this.pos++;
                    this.readUInt32(); // skip type (3 = Polygon)
                    polys.push(this.readPolygon());
                }
                return { type: 'MultiPolygon', coordinates: polys };
            }

            default:
                throw new Error(`Unsupported WKB type: ${wkbType}`);
        }
    }
}

/** Parse GeoPackage Binary blob → GeoJSON geometry */
export function parseGpkgGeometry(blob: Buffer): GeoJSONGeometry {
    // Validate magic
    if (blob[0] !== 0x47 || blob[1] !== 0x50) {
        throw new Error('Not a GeoPackage geometry (missing GP magic)');
    }

    const flags = blob[3];
    const isEmpty = (flags >> 5) & 1;
    if (isEmpty) {
        return { type: 'MultiPolygon', coordinates: [] };
    }

    const envelopeType = (flags >> 1) & 7;
    const envSizes = [0, 32, 48, 48, 64];
    const envSize = envSizes[envelopeType] || 0;
    const wkbStart = 8 + envSize;

    const reader = new WKBReader(blob, wkbStart);
    return reader.readGeometry();
}

import { feature, featureCollection } from '@turf/helpers';
import polygonClipping from 'polygon-clipping';
import simplifyJs from 'simplify-js';

// ────────── Query ──────────

/**
 * Merge polygon coordinates by dissolving them.
 */
async function mergeGeometries(geometries: GeoJSONGeometry[]): Promise<GeoJSONGeometry> {
    const polys: any[] = [];
    for (const g of geometries) {
        if (g.type === 'MultiPolygon') {
            for (const coords of g.coordinates) {
                polys.push(feature({ type: 'Polygon', coordinates: coords } as any));
            }
        } else if (g.type === 'Polygon') {
            polys.push(feature(g as any));
        }
    }

    // Chunked Dissolve
    let currentPolys = polys;
    const CHUNK_SIZE = 100;

    while (currentPolys.length > 1) {
        const nextPolys: any[] = [];

        for (let i = 0; i < currentPolys.length; i += CHUNK_SIZE) {
            const chunk = currentPolys.slice(i, i + CHUNK_SIZE);
            if (chunk.length === 1) {
                nextPolys.push(chunk[0]);
                continue;
            }

            try {
                const startTime = Date.now();
                // Use polygon-clipping instead of Turf.js as turf.dissolve is prone to infinite loops
                const polyCoords = chunk.map(f => {
                    const g = f.geometry;
                    return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
                });

                const unionedCoords = polygonClipping.union(polyCoords[0], ...polyCoords.slice(1));

                if (unionedCoords.length > 0) {
                    nextPolys.push(feature({ type: 'MultiPolygon', coordinates: unionedCoords } as any));
                }
            } catch (e) {
                console.warn('[mergeGeometries] polygon-clipping failed on chunk, falling back to basic merge:', e);
                nextPolys.push(...chunk);
            }
            // microtask yield barrier
            await new Promise(r => setTimeout(r, 0));
        }

        // If length did not decrease, we can't dissolve further
        if (nextPolys.length >= currentPolys.length) {
            currentPolys = nextPolys;
            break;
        }
        currentPolys = nextPolys;
    }

    if (currentPolys.length === 1) {
        return currentPolys[0].geometry as GeoJSONGeometry;
    }

    // fallback if dissolve fails or returns multiple disjoint polygons
    const allPolygons: any[][][] = [];
    for (const p of currentPolys) {
        const g = p.geometry;
        if (g.type === 'MultiPolygon') {
            allPolygons.push(...g.coordinates);
        } else if (g.type === 'Polygon') {
            allPolygons.push(g.coordinates);
        }
    }
    return { type: 'MultiPolygon', coordinates: allPolygons };
}

// ────────── Geometry Optimization ──────────

function optimizeCoordinates(coords: any[], tolerance: number): any[] {
    if (coords.length > 0 && typeof coords[0] === 'number') {
        const x = Number((coords[0] as number).toFixed(5));
        const y = Number((coords[1] as number).toFixed(5));
        return [x, y];
    }

    // If it's a ring of points (array of arrays of numbers)
    if (coords.length > 0 && Array.isArray(coords[0]) && typeof coords[0][0] === 'number') {
        // Map to {x, y} for simplify-js
        let points = coords.map((c: any) => ({ x: c[0], y: c[1] }));
        if (tolerance > 0 && points.length > 2) {
            points = simplifyJs(points, tolerance, false);
        }
        // Map back to [x, y] and round
        return points.map(p => [Number(p.x.toFixed(5)), Number(p.y.toFixed(5))]);
    }

    // Deeper arrays (Polygon / MultiPolygon)
    return coords.map(c => optimizeCoordinates(c, tolerance));
}

/**
 * Get boundary features for a specific GID.
 *
 * The flat GADM table has one row per leaf-level area (all levels filled).
 * This function:
 *   1. Queries all rows where `GID_{gidLevel} = gadmId`
 *   2. Groups them by `GID_{contentLevel}`
 *   3. Merges leaf geometries into one MultiPolygon per group
 *
 * Examples:
 *   - getBoundaryFromGpkg('DEU', 0) → 1 feature (Germany outline, merged from all leaves)
 *   - getBoundaryFromGpkg('DEU.14_1', 2) → 13 features (one per L2 district in Sachsen)
 *   - getBoundaryFromGpkg('DEU.14_1') → 1 feature (Sachsen outline)
 *
 * Returns null if GeoPackage is not available.
 */
import { createRequire } from 'module';

let sharedDb: any = null;
let sharedTableName: string = '';

function ensureDb(): boolean {
    if (sharedDb) return true;
    const gpkgPath = findGpkg();
    if (!gpkgPath) return false;

    let Database: any;
    try {
        if (typeof require !== 'undefined') {
            Database = require('better-sqlite3');
        } else {
            const req = createRequire(import.meta.url);
            Database = req('better-sqlite3');
        }
    } catch (e: any) {
        console.warn('Failed to load better-sqlite3 (GeoPackage bounds will be skipped):', e.message);
        return false;
    }

    sharedDb = new Database(gpkgPath, { readonly: true });
    try {
        const tables: any[] = sharedDb.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'gpkg_%' AND name NOT LIKE 'rtree_%' AND name NOT LIKE 'sqlite_%'"
        ).all();
        sharedTableName = tables.find((t: any) =>
            t.name === 'gadm_410' || t.name === 'gadm41_raw'
        )?.name;
        if (!sharedTableName) {
            sharedDb.close();
            sharedDb = null;
            return false;
        }
        return true;
    } catch (e) {
        sharedDb.close();
        sharedDb = null;
        return false;
    }
}

export interface GadmCache {
    get(key: string): Promise<any>;
    set(key: string, value: any): Promise<void>;
}


export async function getBoundaryFromGpkg(
    gadmId: string,
    contentLevel?: number,
    externalCache?: GadmCache,
    resolution: number = 3
): Promise<BoundaryResult | null> {
    const levelStr = contentLevel != null ? contentLevel.toString() : 'auto';
    const safeId = gadmId.replace(/[^a-zA-Z0-9\.\-_]/g, '_').substring(0, 50);
    const cacheKey = `boundary_${safeId}_${levelStr}`;

    // Resolve cache locations for cross-environment compatibility (Dev Workspace vs Prod Server)
    const possibleCacheDirs = [];
    if (process.env.GADM_CACHE) possibleCacheDirs.push(process.env.GADM_CACHE);
    possibleCacheDirs.push(resolve(process.cwd(), 'cache/gadm'));
    possibleCacheDirs.push(resolve(_dirname, '../cache/gadm'));

    const uniqueCacheDirs = [...new Set(possibleCacheDirs)];

    if (externalCache) {
        try {
            const cached = await externalCache.get(cacheKey);
            if (cached) {
                return cached as BoundaryResult;
            }
        } catch (e) {
            console.warn(`[gpkg-reader] External cache error for ${cacheKey}:`, e);
        }
    }

    const countryCode = gadmId.split('.')[0];
    for (const dir of uniqueCacheDirs) {
        const cacheFile = join(dir, countryCode, `${cacheKey}.json`);
        if (existsSync(cacheFile)) {
            try {
                return JSON.parse(readFileSync(cacheFile, 'utf-8')) as BoundaryResult;
            } catch (e) {
                console.warn(`[gpkg-reader] Failed to read cache from ${cacheFile}:`, e);
            }
        }

        // fallback old flat structure
        const oldCacheFile = join(dir, `${cacheKey}.json`);
        if (existsSync(oldCacheFile)) {
            try {
                return JSON.parse(readFileSync(oldCacheFile, 'utf-8')) as BoundaryResult;
            } catch (e) {
                console.warn(`[gpkg-reader] Failed to read backup cache from ${oldCacheFile}:`, e);
            }
        }
    }

    // Fallback: check for C++ pre-built cache (boundary_{COUNTRY}_{LEVEL}.json)
    const dotCount = (gadmId.match(/\./g) || []).length;
    const gidLevel = dotCount;
    const resolvedLevel = contentLevel != null ? contentLevel : gidLevel;

    const fallbackNames = [
        `boundary_${gadmId}_${resolvedLevel}.json`,
        `boundary_${countryCode}_${resolvedLevel}.json`
    ];

    const uniqueFallbackNames = [...new Set(fallbackNames)];

    const isSubRegion = gadmId.includes('.');
    const baseGid = isSubRegion ? gadmId.replace(/_\d+$/, '') : gadmId;
    const gidPrefix = isSubRegion ? baseGid + '.' : null;

    for (const cppFileName of uniqueFallbackNames) {
        for (const dir of uniqueCacheDirs) {
            let cppFile = join(dir, countryCode, cppFileName);
            if (!existsSync(cppFile)) {
                cppFile = join(dir, cppFileName);
            }
            if (existsSync(cppFile)) {
                try {
                    const raw = JSON.parse(readFileSync(cppFile, 'utf-8'));
                    if (raw.features && Array.isArray(raw.features)) {
                        let rawFeatures = raw.features;

                        if (gidPrefix && cppFileName.includes(countryCode) && !cppFileName.includes(gadmId)) {
                            rawFeatures = rawFeatures.filter((f: any) => {
                                if (!f.code) return false;
                                if (resolvedLevel === gidLevel) {
                                    return f.code === gadmId || f.code.replace(/_\d+$/, '') === baseGid;
                                }
                                return f.code.startsWith(gidPrefix);
                            });
                        }

                        if (rawFeatures.length === 0) {
                            continue;
                        }

                        const features: BoundaryFeature[] = rawFeatures.map((f: any) => {
                            const { geometry, code, name, ...enrichment } = f;
                            return {
                                type: 'Feature' as const,
                                properties: { name, code, ...enrichment },
                                geometry,
                            };
                        });

                        const result: BoundaryResult = { type: 'FeatureCollection', features };
                        const targetBase = uniqueCacheDirs[1] || uniqueCacheDirs[0];
                        const targetDir = join(targetBase, countryCode);
                        if (!existsSync(targetDir)) {
                            mkdirSync(targetDir, { recursive: true });
                        }
                        const outCacheFile = join(targetDir, `${cacheKey}.json`);
                        try {
                            writeFileSync(outCacheFile, JSON.stringify(result));
                        } catch (e) {
                            console.warn(`[gpkg-reader] Failed to save JS cache: ${outCacheFile}`, e);
                        }
                        return result;
                    } else {
                        console.log(`[gpkg-reader] CPP file had no .features array: ${cppFile}`);
                    }
                } catch (e) {
                    console.warn(`[gpkg-reader] Failed to read C++ cache from ${cppFile}:`, e);
                }
            } else {
                console.log(`[gpkg-reader] MISS CPP fallback path: ${cppFile}`);
            }
        }
    }

    console.log(`[gpkg-reader] No cache found for ${gadmId}, falling back to SQLite GeoPackage`);
    if (!ensureDb()) {
        console.error(`[gpkg-reader] GeoPackage DB init failed for ${gadmId}, returning null`);
        return null;
    }

    const db = sharedDb;
    const tableName = sharedTableName;

    // Determine the GID's own level from dot count: "ESP" = L0, "ESP.6_1" = L1
    // (dotCount and gidLevel already defined above)
    const level = contentLevel != null ? contentLevel : gidLevel;

    // Columns to select
    const propCols: string[] = [];
    for (let l = 0; l <= Math.min(level, 5); l++) {
        propCols.push(`NAME_${l}`, `GID_${l}`);
    }
    const allCols = ['geom', ...propCols].filter((c, i, a) => a.indexOf(c) === i);
    const colList = allCols.map(c => `"${c}"`).join(', ');

    try {
        // Query all leaf rows for this GID
        const gidCol = `GID_${gidLevel}`;
        const rows: any[] = db.prepare(
            `SELECT ${colList} FROM "${tableName}" WHERE "${gidCol}" = ?`
        ).all(gadmId);

        if (rows.length === 0) return null;

        // Group by content-level GID, merge geometries
        const groupCol = `GID_${level}`;
        const groups = new Map<string, { props: Record<string, any>; geoms: GeoJSONGeometry[] }>();

        for (const row of rows) {
            if (!row.geom) continue;
            const groupKey = row[groupCol] || gadmId;

            if (!groups.has(groupKey)) {
                const props: Record<string, any> = {};
                for (const col of propCols) {
                    if (row[col] != null) props[col] = String(row[col]);
                }
                groups.set(groupKey, { props, geoms: [] });
            }

            try {
                const geometry = parseGpkgGeometry(Buffer.from(row.geom));
                groups.get(groupKey)!.geoms.push(geometry);
            } catch (e) {
                console.warn(`[gpkg-reader] Failed to parse geometry for ${groupKey}:`, e);
            }
        }

        // Build features
        const features: BoundaryFeature[] = [];
        for (const [, { props, geoms }] of groups) {
            if (geoms.length === 0) continue;
            const geometry = geoms.length === 1 ? geoms[0] : await mergeGeometries(geoms);

            if (level === gidLevel) {
                props.isOuter = true;
            }

            features.push({ type: 'Feature', properties: props, geometry });
        }

        // Removed includeOuter unshift logic entirely

        let result: BoundaryResult = { type: 'FeatureCollection', features };

        // Determine tolerance for simplification based on resolution
        let tolerance = 0.0;
        switch (resolution) {
            case 1: tolerance = 0.0; break;
            case 2: tolerance = 0.001; break;
            case 3: tolerance = 0.002; break;
            case 4: tolerance = 0.005; break;
            case 5: tolerance = 0.01; break;
            case 6: tolerance = 0.05; break;
            default: tolerance = 0.0; break;
        }

        // Simplify and truncate geometries to reduce payload size safely
        const simplifiedFeatures: BoundaryFeature[] = [];
        for (const feat of result.features) {
            try {
                // recursively simplify and truncate to 5 decimal places matching C++ processing
                feat.geometry.coordinates = optimizeCoordinates(feat.geometry.coordinates, tolerance);
            } catch (e) {
                console.warn(`[gpkg-reader] geometry optimization failed for ${gadmId}:`, e);
            }
            simplifiedFeatures.push(feat);
        }
        result = { type: 'FeatureCollection', features: simplifiedFeatures };

        // Enrich features with population and built density data
        for (const feat of result.features) {
            try {
                const enriched = await enrichFeatureWithGHS(feat, { pop: true, built: true });
                Object.assign(feat.properties, enriched);
            } catch (err) {
                console.warn(`[gpkg-reader] GHS enrichment failed for ${gadmId}:`, err);
            }
        }

        if (externalCache) {
            try {
                await externalCache.set(cacheKey, result);
            } catch (e) { /* ignore */ }
        } else {
            const targetDir = join(uniqueCacheDirs[0], gadmId.split('.')[0]);
            const targetFile = join(targetDir, `${cacheKey}.json`);
            try {
                if (!existsSync(targetDir)) {
                    mkdirSync(targetDir, { recursive: true });
                }
                writeFileSync(targetFile, JSON.stringify(result));
            } catch (e) {
                console.warn(`[gpkg-reader] Failed to write cache for ${gadmId}:`, e);
            }
        }
        return result;
    } catch (err) {
        console.error("Error reading from GeoPackage:", err);
        return null;
    }
}

// ────────── Point in Polygon ──────────

function pointInRing(pt: [number, number], ring: [number, number][]): boolean {
    let isInside = false;
    const [x, y] = pt;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) isInside = !isInside;
    }
    return isInside;
}

function pointInPolygon(pt: [number, number], polygon: [number, number][][]): boolean {
    if (polygon.length === 0) return false;
    if (!pointInRing(pt, polygon[0])) return false;
    for (let i = 1; i < polygon.length; i++) {
        if (pointInRing(pt, polygon[i])) return false;
    }
    return true;
}

function pointInMultiPolygon(pt: [number, number], multiPolygon: [number, number][][][]): boolean {
    for (const poly of multiPolygon) {
        if (pointInPolygon(pt, poly)) return true;
    }
    return false;
}

export function containsPoint(geom: GeoJSONGeometry, pt: [number, number]): boolean {
    if (geom.type === 'Polygon') {
        return pointInPolygon(pt, geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
        return pointInMultiPolygon(pt, geom.coordinates);
    }
    return false;
}

export interface GadmPointResult {
    level: number;
    gadmName: string | null;
    gid: string | null;
}

/**
 * Distinct GID/NAME at `level` whose leaf geometries overlap the given bbox (rtree).
 * Sync — blocks the event loop (prefer {@link queryUniqueGidsInBboxAsync} on HTTP paths).
 */
export function queryUniqueGidsInBbox(
    bbox: [number, number, number, number],
    level: number,
): Array<{ gid: string; name: string }> {
    if (!ensureDb()) {
        console.warn('[gadm] queryUniqueGidsInBbox: GeoPackage DB not available');
        return [];
    }
    if (level < 0 || level > 5) {
        console.warn('[gadm] queryUniqueGidsInBbox: invalid level', level);
        return [];
    }

    const db = sharedDb;
    const tableName = sharedTableName;
    const [minx, miny, maxx, maxy] = bbox;
    const gidCol = `GID_${level}`;
    const nameCol = `NAME_${level}`;

    try {
        const rows: any[] = db.prepare(
            `SELECT DISTINCT a."${gidCol}" AS gid, a."${nameCol}" AS name
             FROM "${tableName}" a
             JOIN "rtree_${tableName}_geom" b ON a.fid = b.id
             WHERE b.maxx >= ? AND b.minx <= ? AND b.maxy >= ? AND b.miny <= ?
               AND a."${gidCol}" IS NOT NULL`
        ).all(minx, maxx, miny, maxy);

        const out: Array<{ gid: string; name: string }> = [];
        const seen = new Set<string>();
        for (const r of rows) {
            if (!r?.gid || typeof r.gid !== 'string') continue;
            if (seen.has(r.gid)) continue;
            seen.add(r.gid);
            out.push({ gid: r.gid, name: typeof r.name === 'string' ? r.name : r.gid });
        }
        return out;
    } catch (err) {
        console.error('[gadm] queryUniqueGidsInBbox error:', err);
        return [];
    }
}

// ─── bbox worker (keeps 2.5GB gpkg sqlite off the HTTP thread) ───────────────

type BboxHit = { gid: string; name: string };
type BboxPending = {
    resolve: (hits: BboxHit[]) => void;
    reject: (err: Error) => void;
};

let _bboxWorker: Worker | null = null;
let _bboxMsgId = 0;
const _bboxPending = new Map<number, BboxPending>();

function getBboxWorker(): Worker | null {
    if (_bboxWorker) return _bboxWorker;
    try {
        const workerPath = resolve(_dirname, 'gpkg-bbox-worker.mjs');
        if (!existsSync(workerPath)) {
            console.warn('[gadm] bbox worker missing:', workerPath);
            return null;
        }
        _bboxWorker = new Worker(workerPath);
        _bboxWorker.on('message', (msg: { id: number; ok: boolean; hits?: BboxHit[]; error?: string }) => {
            const p = _bboxPending.get(msg.id);
            if (!p) return;
            _bboxPending.delete(msg.id);
            if (msg.ok) p.resolve(msg.hits || []);
            else p.reject(new Error(msg.error || 'bbox worker error'));
        });
        _bboxWorker.on('error', (err) => {
            console.error('[gadm] bbox worker error:', err);
            for (const [, p] of _bboxPending) p.reject(err instanceof Error ? err : new Error(String(err)));
            _bboxPending.clear();
            _bboxWorker = null;
        });
        _bboxWorker.on('exit', (code) => {
            if (code !== 0) console.warn('[gadm] bbox worker exited', code);
            _bboxWorker = null;
        });
        return _bboxWorker;
    } catch (e) {
        console.warn('[gadm] failed to start bbox worker:', e);
        return null;
    }
}

/**
 * Same as {@link queryUniqueGidsInBbox} but runs in a worker thread so the
 * HTTP event loop (gridsearch, health, pg) stays responsive while sqlite works.
 */
export function queryUniqueGidsInBboxAsync(
    bbox: [number, number, number, number],
    level: number,
): Promise<Array<{ gid: string; name: string }>> {
    const gpkgPath = findGpkg();
    if (!gpkgPath) return Promise.resolve([]);
    if (level < 0 || level > 5) return Promise.resolve([]);

    const worker = getBboxWorker();
    if (!worker) {
        // Fallback: sync on main thread (dev without worker file).
        return new Promise((resolve) => {
            setImmediate(() => resolve(queryUniqueGidsInBbox(bbox, level)));
        });
    }

    const id = ++_bboxMsgId;
    return new Promise((resolve, reject) => {
        _bboxPending.set(id, { resolve, reject });
        worker.postMessage({ id, gpkgPath, bbox, level });
    });
}

/**
 * Perform a spatial query to find the exact GADM hierarchy containing a point.
 */
export function getHierarchyByPoint(lat: number, lon: number): GadmPointResult[] | null {
    if (!ensureDb()) return null;

    const db = sharedDb;
    const tableName = sharedTableName;

    try {
        const rows: any[] = db.prepare(
            `SELECT a.* FROM "${tableName}" a
             JOIN "rtree_${tableName}_geom" b ON a.fid = b.id
             WHERE b.minx <= ? AND b.maxx >= ? AND b.miny <= ? AND b.maxy >= ?`
        ).all(lon, lon, lat, lat);

        for (const row of rows) {
            if (!row.geom) continue;
            try {
                const geometry = parseGpkgGeometry(Buffer.from(row.geom));
                if (containsPoint(geometry, [lon, lat])) {
                    // Exact match found among candidate bounding boxes!
                    const results: GadmPointResult[] = [];
                    for (let i = 0; i <= 5; i++) {
                        const gid = row[`GID_${i}`];
                        const name = row[`NAME_${i}`];
                        if (gid || name) {
                            results.push({
                                level: i,
                                gadmName: name || null,
                                gid: gid || null
                            });
                        }
                    }
                    return results;
                }
            } catch (e) {
                // Ignore parsing errors for individual geometries
            }
        }
        return null;
    } catch (err) {
        console.error("Error performing spatial point query against GeoPackage:", err);
        return null;
    }
}

/**
 * Perform a point-in-polygon hierarchy query using only the pre-generated JSON cache.
 * Avoids any SQLite dependency.
 */
export async function getHierarchyByPointFromCache(lat: number, lon: number, isoCode: string, additionalCacheDirs?: string[]): Promise<GadmPointResult[] | null> {
    if (!isoCode) {
        console.log(`[gadm-cache] REJECTED: no isoCode provided for lat=${lat}, lon=${lon}`);
        return null;
    }

    let countryCode = isoCode.toUpperCase();
    if (countryCode.length === 2) {
        console.log(`[gadm-cache] WARNING: received 2-letter ISO code: ${countryCode}. Cache dirs usually expect ISO-3.`);
    }

    const pt = turf.point([lon, lat]);

    const possibleCacheDirs: string[] = [];
    if (additionalCacheDirs && additionalCacheDirs.length > 0) {
        possibleCacheDirs.push(...additionalCacheDirs);
    }
    if (process.env.GADM_CACHE) possibleCacheDirs.push(process.env.GADM_CACHE);
    possibleCacheDirs.push(resolve(process.cwd(), 'cache/gadm'));
    //possibleCacheDirs.push(resolve(__dirname, '../cache/gadm'));
    const uniqueCacheDirs = [...new Set(possibleCacheDirs)];
    // Check downwards from most detailed to least (country base).
    for (let level = 5; level >= 0; level--) {
        const cppFileName = `boundary_${countryCode}_${level}.json`;
        for (const dir of uniqueCacheDirs) {
            let cppFile = join(dir, countryCode, cppFileName);
            if (!existsSync(cppFile)) {
                cppFile = join(dir, cppFileName);
            }
            if (!existsSync(cppFile)) {
                continue;
            }
            try {
                const raw = JSON.parse(readFileSync(cppFile, 'utf-8'));
                if (raw.features && Array.isArray(raw.features)) {
                    let matchedCount = 0;
                    for (const feat of raw.features) {
                        try {
                            if (turf.booleanPointInPolygon(pt, feat as any)) {
                                matchedCount++;
                                const props = feat.properties || {} as any;
                                let leafGid = props.code || (feat as any).code;

                                if (!leafGid) {
                                    // Native cache generated by getBoundaryFromGpkg
                                    // Contains NAME_0..5 and GID_0..5 directly in properties
                                    for (let i = 5; i >= 0; i--) {
                                        if (props[`GID_${i}`]) {
                                            leafGid = props[`GID_${i}`];
                                            break;
                                        }
                                    }
                                }

                                if (leafGid) {
                                    // If we have native hierarchy inline, return it without an extra Parquet lookup
                                    if (props.GID_0 && props.NAME_0) {
                                        const results: GadmPointResult[] = [];
                                        for (let i = 0; i <= 5; i++) {
                                            const gid = props[`GID_${i}`];
                                            const name = props[`NAME_${i}`];
                                            if (gid || name) {
                                                results.push({
                                                    level: i,
                                                    gadmName: name ? String(name) : null,
                                                    gid: gid ? String(gid) : null
                                                });
                                            }
                                        }
                                        return results;
                                    } else {
                                        // It's a C++ cache, so use getNames to walk up the hierarchy 
                                        const namesResult = await getNames({ admin: leafGid, complete: true });
                                        if (namesResult && namesResult.rows && namesResult.rows.length > 0) {
                                            const row = namesResult.rows[0];
                                            const results: GadmPointResult[] = [];
                                            for (let i = 0; i <= 5; i++) {
                                                const gid = row[`GID_${i}`];
                                                const name = row[`NAME_${i}`];
                                                if (gid || name) {
                                                    results.push({
                                                        level: i,
                                                        gadmName: name ? String(name) : null,
                                                        gid: gid ? String(gid) : null
                                                    });
                                                }
                                            }
                                            return results;
                                        } else {
                                            console.log(`[gadm-cache] WARNING: getNames() failed to return rows for admin=${leafGid}`);
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            // Single feature point-in-polygon failed (e.g., weird geometry), skip
                        }
                    }
                    if (matchedCount === 0) {
                        console.log(`[gadm-cache] Point in Polygon matched NO features at Level ${level}`);
                    }
                } else {
                    console.log(`[gadm-cache] WARNING: Cache file ${cppFile} is empty or lacks features array`);
                }
            } catch (e) {
                console.warn(`[gadm-cache] Failed to read or parse cache from ${cppFile}:`, e);
            }
        }
    }

    console.log(`[gadm-cache] FAILED: Could not match point to any feature in any cache level`);
    return null;
}
