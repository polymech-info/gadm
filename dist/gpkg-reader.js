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
let _gpkgPath = null;
/** Set or override the GeoPackage file path */
export function setGpkgPath(p) {
    _gpkgPath = p;
}
function findGpkg() {
    if (_gpkgPath && existsSync(_gpkgPath))
        return _gpkgPath;
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
    buf;
    pos;
    le; // little-endian
    constructor(buf, offset) {
        this.buf = buf;
        this.pos = offset;
        // First byte of WKB = endianness indicator
        this.le = this.buf[this.pos] === 1;
        this.pos++;
    }
    readUInt32() {
        const v = this.le
            ? this.buf.readUInt32LE(this.pos)
            : this.buf.readUInt32BE(this.pos);
        this.pos += 4;
        return v;
    }
    readDouble() {
        const v = this.le
            ? this.buf.readDoubleLE(this.pos)
            : this.buf.readDoubleBE(this.pos);
        this.pos += 8;
        return v;
    }
    readCoord() {
        const x = this.readDouble(); // longitude
        const y = this.readDouble(); // latitude
        return [x, y];
    }
    readRing() {
        const count = this.readUInt32();
        const ring = [];
        for (let i = 0; i < count; i++) {
            ring.push(this.readCoord());
        }
        return ring;
    }
    readPolygon() {
        const ringCount = this.readUInt32();
        const rings = [];
        for (let i = 0; i < ringCount; i++) {
            rings.push(this.readRing());
        }
        return rings;
    }
    readGeometry() {
        const wkbType = this.readUInt32();
        switch (wkbType) {
            case 1: // Point
                return { type: 'Point', coordinates: this.readCoord() };
            case 2: { // LineString
                const count = this.readUInt32();
                const coords = [];
                for (let i = 0; i < count; i++)
                    coords.push(this.readCoord());
                return { type: 'LineString', coordinates: coords };
            }
            case 3: // Polygon
                return { type: 'Polygon', coordinates: this.readPolygon() };
            case 4: { // MultiPoint
                const count = this.readUInt32();
                const points = [];
                for (let i = 0; i < count; i++) {
                    this.le = this.buf[this.pos] === 1;
                    this.pos++;
                    this.readUInt32(); // skip type
                    points.push(this.readCoord());
                }
                return { type: 'MultiPoint', coordinates: points };
            }
            case 5: { // MultiLineString
                const count = this.readUInt32();
                const lines = [];
                for (let i = 0; i < count; i++) {
                    this.le = this.buf[this.pos] === 1;
                    this.pos++;
                    this.readUInt32(); // skip type
                    const ptCount = this.readUInt32();
                    const coords = [];
                    for (let j = 0; j < ptCount; j++)
                        coords.push(this.readCoord());
                    lines.push(coords);
                }
                return { type: 'MultiLineString', coordinates: lines };
            }
            case 6: { // MultiPolygon
                const count = this.readUInt32();
                const polys = [];
                for (let i = 0; i < count; i++) {
                    this.le = this.buf[this.pos] === 1;
                    this.pos++;
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
export function parseGpkgGeometry(blob) {
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
import { feature } from '@turf/helpers';
import polygonClipping from 'polygon-clipping';
import simplifyJs from 'simplify-js';
// ────────── Query ──────────
/**
 * Merge polygon coordinates by dissolving them.
 */
async function mergeGeometries(geometries) {
    const polys = [];
    for (const g of geometries) {
        if (g.type === 'MultiPolygon') {
            for (const coords of g.coordinates) {
                polys.push(feature({ type: 'Polygon', coordinates: coords }));
            }
        }
        else if (g.type === 'Polygon') {
            polys.push(feature(g));
        }
    }
    // Chunked Dissolve
    let currentPolys = polys;
    const CHUNK_SIZE = 100;
    while (currentPolys.length > 1) {
        const nextPolys = [];
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
                    nextPolys.push(feature({ type: 'MultiPolygon', coordinates: unionedCoords }));
                }
            }
            catch (e) {
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
        return currentPolys[0].geometry;
    }
    // fallback if dissolve fails or returns multiple disjoint polygons
    const allPolygons = [];
    for (const p of currentPolys) {
        const g = p.geometry;
        if (g.type === 'MultiPolygon') {
            allPolygons.push(...g.coordinates);
        }
        else if (g.type === 'Polygon') {
            allPolygons.push(g.coordinates);
        }
    }
    return { type: 'MultiPolygon', coordinates: allPolygons };
}
// ────────── Geometry Optimization ──────────
function optimizeCoordinates(coords, tolerance) {
    if (coords.length > 0 && typeof coords[0] === 'number') {
        const x = Number(coords[0].toFixed(5));
        const y = Number(coords[1].toFixed(5));
        return [x, y];
    }
    // If it's a ring of points (array of arrays of numbers)
    if (coords.length > 0 && Array.isArray(coords[0]) && typeof coords[0][0] === 'number') {
        // Map to {x, y} for simplify-js
        let points = coords.map((c) => ({ x: c[0], y: c[1] }));
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
let sharedDb = null;
let sharedTableName = '';
function ensureDb() {
    if (sharedDb)
        return true;
    const gpkgPath = findGpkg();
    if (!gpkgPath)
        return false;
    let Database;
    try {
        if (typeof require !== 'undefined') {
            Database = require('better-sqlite3');
        }
        else {
            const req = createRequire(import.meta.url);
            Database = req('better-sqlite3');
        }
    }
    catch (e) {
        console.warn('Failed to load better-sqlite3 (GeoPackage bounds will be skipped):', e.message);
        return false;
    }
    sharedDb = new Database(gpkgPath, { readonly: true });
    try {
        const tables = sharedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'gpkg_%' AND name NOT LIKE 'rtree_%' AND name NOT LIKE 'sqlite_%'").all();
        sharedTableName = tables.find((t) => t.name === 'gadm_410' || t.name === 'gadm41_raw')?.name;
        if (!sharedTableName) {
            sharedDb.close();
            sharedDb = null;
            return false;
        }
        return true;
    }
    catch (e) {
        sharedDb.close();
        sharedDb = null;
        return false;
    }
}
export async function getBoundaryFromGpkg(gadmId, contentLevel, externalCache, resolution = 3) {
    const levelStr = contentLevel != null ? contentLevel.toString() : 'auto';
    const safeId = gadmId.replace(/[^a-zA-Z0-9\.\-_]/g, '_').substring(0, 50);
    const cacheKey = `boundary_${safeId}_${levelStr}`;
    // Resolve cache locations for cross-environment compatibility (Dev Workspace vs Prod Server)
    const possibleCacheDirs = [];
    if (process.env.GADM_CACHE)
        possibleCacheDirs.push(process.env.GADM_CACHE);
    possibleCacheDirs.push(resolve(process.cwd(), 'cache/gadm'));
    possibleCacheDirs.push(resolve(_dirname, '../cache/gadm'));
    const uniqueCacheDirs = [...new Set(possibleCacheDirs)];
    if (externalCache) {
        try {
            const cached = await externalCache.get(cacheKey);
            if (cached) {
                return cached;
            }
        }
        catch (e) {
            console.warn(`[gpkg-reader] External cache error for ${cacheKey}:`, e);
        }
    }
    const countryCode = gadmId.split('.')[0];
    for (const dir of uniqueCacheDirs) {
        const cacheFile = join(dir, countryCode, `${cacheKey}.json`);
        if (existsSync(cacheFile)) {
            try {
                return JSON.parse(readFileSync(cacheFile, 'utf-8'));
            }
            catch (e) {
                console.warn(`[gpkg-reader] Failed to read cache from ${cacheFile}:`, e);
            }
        }
        // fallback old flat structure
        const oldCacheFile = join(dir, `${cacheKey}.json`);
        if (existsSync(oldCacheFile)) {
            try {
                return JSON.parse(readFileSync(oldCacheFile, 'utf-8'));
            }
            catch (e) {
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
                            rawFeatures = rawFeatures.filter((f) => {
                                if (!f.code)
                                    return false;
                                if (resolvedLevel === gidLevel) {
                                    return f.code === gadmId || f.code.replace(/_\d+$/, '') === baseGid;
                                }
                                return f.code.startsWith(gidPrefix);
                            });
                        }
                        if (rawFeatures.length === 0) {
                            continue;
                        }
                        const features = rawFeatures.map((f) => {
                            const { geometry, code, name, ...enrichment } = f;
                            return {
                                type: 'Feature',
                                properties: { name, code, ...enrichment },
                                geometry,
                            };
                        });
                        const result = { type: 'FeatureCollection', features };
                        const targetBase = uniqueCacheDirs[1] || uniqueCacheDirs[0];
                        const targetDir = join(targetBase, countryCode);
                        if (!existsSync(targetDir)) {
                            mkdirSync(targetDir, { recursive: true });
                        }
                        const outCacheFile = join(targetDir, `${cacheKey}.json`);
                        try {
                            writeFileSync(outCacheFile, JSON.stringify(result));
                        }
                        catch (e) {
                            console.warn(`[gpkg-reader] Failed to save JS cache: ${outCacheFile}`, e);
                        }
                        return result;
                    }
                    else {
                        console.log(`[gpkg-reader] CPP file had no .features array: ${cppFile}`);
                    }
                }
                catch (e) {
                    console.warn(`[gpkg-reader] Failed to read C++ cache from ${cppFile}:`, e);
                }
            }
            else {
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
    const propCols = [];
    for (let l = 0; l <= Math.min(level, 5); l++) {
        propCols.push(`NAME_${l}`, `GID_${l}`);
    }
    const allCols = ['geom', ...propCols].filter((c, i, a) => a.indexOf(c) === i);
    const colList = allCols.map(c => `"${c}"`).join(', ');
    try {
        // Query all leaf rows for this GID
        const gidCol = `GID_${gidLevel}`;
        const rows = db.prepare(`SELECT ${colList} FROM "${tableName}" WHERE "${gidCol}" = ?`).all(gadmId);
        if (rows.length === 0)
            return null;
        // Group by content-level GID, merge geometries
        const groupCol = `GID_${level}`;
        const groups = new Map();
        for (const row of rows) {
            if (!row.geom)
                continue;
            const groupKey = row[groupCol] || gadmId;
            if (!groups.has(groupKey)) {
                const props = {};
                for (const col of propCols) {
                    if (row[col] != null)
                        props[col] = String(row[col]);
                }
                groups.set(groupKey, { props, geoms: [] });
            }
            try {
                const geometry = parseGpkgGeometry(Buffer.from(row.geom));
                groups.get(groupKey).geoms.push(geometry);
            }
            catch (e) {
                console.warn(`[gpkg-reader] Failed to parse geometry for ${groupKey}:`, e);
            }
        }
        // Build features
        const features = [];
        for (const [, { props, geoms }] of groups) {
            if (geoms.length === 0)
                continue;
            const geometry = geoms.length === 1 ? geoms[0] : await mergeGeometries(geoms);
            if (level === gidLevel) {
                props.isOuter = true;
            }
            features.push({ type: 'Feature', properties: props, geometry });
        }
        // Removed includeOuter unshift logic entirely
        let result = { type: 'FeatureCollection', features };
        // Determine tolerance for simplification based on resolution
        let tolerance = 0.0;
        switch (resolution) {
            case 1:
                tolerance = 0.0;
                break;
            case 2:
                tolerance = 0.001;
                break;
            case 3:
                tolerance = 0.002;
                break;
            case 4:
                tolerance = 0.005;
                break;
            case 5:
                tolerance = 0.01;
                break;
            case 6:
                tolerance = 0.05;
                break;
            default:
                tolerance = 0.0;
                break;
        }
        // Simplify and truncate geometries to reduce payload size safely
        const simplifiedFeatures = [];
        for (const feat of result.features) {
            try {
                // recursively simplify and truncate to 5 decimal places matching C++ processing
                feat.geometry.coordinates = optimizeCoordinates(feat.geometry.coordinates, tolerance);
            }
            catch (e) {
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
            }
            catch (err) {
                console.warn(`[gpkg-reader] GHS enrichment failed for ${gadmId}:`, err);
            }
        }
        if (externalCache) {
            try {
                await externalCache.set(cacheKey, result);
            }
            catch (e) { /* ignore */ }
        }
        else {
            const targetDir = join(uniqueCacheDirs[0], gadmId.split('.')[0]);
            const targetFile = join(targetDir, `${cacheKey}.json`);
            try {
                if (!existsSync(targetDir)) {
                    mkdirSync(targetDir, { recursive: true });
                }
                writeFileSync(targetFile, JSON.stringify(result));
            }
            catch (e) {
                console.warn(`[gpkg-reader] Failed to write cache for ${gadmId}:`, e);
            }
        }
        return result;
    }
    catch (err) {
        console.error("Error reading from GeoPackage:", err);
        return null;
    }
}
// ────────── Point in Polygon ──────────
function pointInRing(pt, ring) {
    let isInside = false;
    const [x, y] = pt;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect)
            isInside = !isInside;
    }
    return isInside;
}
function pointInPolygon(pt, polygon) {
    if (polygon.length === 0)
        return false;
    if (!pointInRing(pt, polygon[0]))
        return false;
    for (let i = 1; i < polygon.length; i++) {
        if (pointInRing(pt, polygon[i]))
            return false;
    }
    return true;
}
function pointInMultiPolygon(pt, multiPolygon) {
    for (const poly of multiPolygon) {
        if (pointInPolygon(pt, poly))
            return true;
    }
    return false;
}
export function containsPoint(geom, pt) {
    if (geom.type === 'Polygon') {
        return pointInPolygon(pt, geom.coordinates);
    }
    else if (geom.type === 'MultiPolygon') {
        return pointInMultiPolygon(pt, geom.coordinates);
    }
    return false;
}
/**
 * Distinct GID/NAME at `level` whose leaf geometries overlap the given bbox (rtree).
 * Sync — blocks the event loop (prefer {@link queryUniqueGidsInBboxAsync} on HTTP paths).
 */
export function queryUniqueGidsInBbox(bbox, level) {
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
        const rows = db.prepare(`SELECT DISTINCT a."${gidCol}" AS gid, a."${nameCol}" AS name
             FROM "${tableName}" a
             JOIN "rtree_${tableName}_geom" b ON a.fid = b.id
             WHERE b.maxx >= ? AND b.minx <= ? AND b.maxy >= ? AND b.miny <= ?
               AND a."${gidCol}" IS NOT NULL`).all(minx, maxx, miny, maxy);
        const out = [];
        const seen = new Set();
        for (const r of rows) {
            if (!r?.gid || typeof r.gid !== 'string')
                continue;
            if (seen.has(r.gid))
                continue;
            seen.add(r.gid);
            out.push({ gid: r.gid, name: typeof r.name === 'string' ? r.name : r.gid });
        }
        return out;
    }
    catch (err) {
        console.error('[gadm] queryUniqueGidsInBbox error:', err);
        return [];
    }
}
let _bboxWorker = null;
let _bboxMsgId = 0;
const _bboxPending = new Map();
function getBboxWorker() {
    if (_bboxWorker)
        return _bboxWorker;
    try {
        const workerPath = resolve(_dirname, 'gpkg-bbox-worker.mjs');
        if (!existsSync(workerPath)) {
            console.warn('[gadm] bbox worker missing:', workerPath);
            return null;
        }
        _bboxWorker = new Worker(workerPath);
        _bboxWorker.on('message', (msg) => {
            const p = _bboxPending.get(msg.id);
            if (!p)
                return;
            _bboxPending.delete(msg.id);
            if (msg.ok)
                p.resolve(msg.hits || []);
            else
                p.reject(new Error(msg.error || 'bbox worker error'));
        });
        _bboxWorker.on('error', (err) => {
            console.error('[gadm] bbox worker error:', err);
            for (const [, p] of _bboxPending)
                p.reject(err instanceof Error ? err : new Error(String(err)));
            _bboxPending.clear();
            _bboxWorker = null;
        });
        _bboxWorker.on('exit', (code) => {
            if (code !== 0)
                console.warn('[gadm] bbox worker exited', code);
            _bboxWorker = null;
        });
        return _bboxWorker;
    }
    catch (e) {
        console.warn('[gadm] failed to start bbox worker:', e);
        return null;
    }
}
/**
 * Same as {@link queryUniqueGidsInBbox} but runs in a worker thread so the
 * HTTP event loop (gridsearch, health, pg) stays responsive while sqlite works.
 */
export function queryUniqueGidsInBboxAsync(bbox, level) {
    const gpkgPath = findGpkg();
    if (!gpkgPath)
        return Promise.resolve([]);
    if (level < 0 || level > 5)
        return Promise.resolve([]);
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
export function getHierarchyByPoint(lat, lon) {
    if (!ensureDb())
        return null;
    const db = sharedDb;
    const tableName = sharedTableName;
    try {
        const rows = db.prepare(`SELECT a.* FROM "${tableName}" a
             JOIN "rtree_${tableName}_geom" b ON a.fid = b.id
             WHERE b.minx <= ? AND b.maxx >= ? AND b.miny <= ? AND b.maxy >= ?`).all(lon, lon, lat, lat);
        for (const row of rows) {
            if (!row.geom)
                continue;
            try {
                const geometry = parseGpkgGeometry(Buffer.from(row.geom));
                if (containsPoint(geometry, [lon, lat])) {
                    // Exact match found among candidate bounding boxes!
                    const results = [];
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
            }
            catch (e) {
                // Ignore parsing errors for individual geometries
            }
        }
        return null;
    }
    catch (err) {
        console.error("Error performing spatial point query against GeoPackage:", err);
        return null;
    }
}
/**
 * Perform a point-in-polygon hierarchy query using only the pre-generated JSON cache.
 * Avoids any SQLite dependency.
 */
export async function getHierarchyByPointFromCache(lat, lon, isoCode, additionalCacheDirs) {
    if (!isoCode) {
        console.log(`[gadm-cache] REJECTED: no isoCode provided for lat=${lat}, lon=${lon}`);
        return null;
    }
    let countryCode = isoCode.toUpperCase();
    if (countryCode.length === 2) {
        console.log(`[gadm-cache] WARNING: received 2-letter ISO code: ${countryCode}. Cache dirs usually expect ISO-3.`);
    }
    const pt = turf.point([lon, lat]);
    const possibleCacheDirs = [];
    if (additionalCacheDirs && additionalCacheDirs.length > 0) {
        possibleCacheDirs.push(...additionalCacheDirs);
    }
    if (process.env.GADM_CACHE)
        possibleCacheDirs.push(process.env.GADM_CACHE);
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
                            if (turf.booleanPointInPolygon(pt, feat)) {
                                matchedCount++;
                                const props = feat.properties || {};
                                let leafGid = props.code || feat.code;
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
                                        const results = [];
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
                                    }
                                    else {
                                        // It's a C++ cache, so use getNames to walk up the hierarchy 
                                        const namesResult = await getNames({ admin: leafGid, complete: true });
                                        if (namesResult && namesResult.rows && namesResult.rows.length > 0) {
                                            const row = namesResult.rows[0];
                                            const results = [];
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
                                        }
                                        else {
                                            console.log(`[gadm-cache] WARNING: getNames() failed to return rows for admin=${leafGid}`);
                                        }
                                    }
                                }
                            }
                        }
                        catch (e) {
                            // Single feature point-in-polygon failed (e.g., weird geometry), skip
                        }
                    }
                    if (matchedCount === 0) {
                        console.log(`[gadm-cache] Point in Polygon matched NO features at Level ${level}`);
                    }
                }
                else {
                    console.log(`[gadm-cache] WARNING: Cache file ${cppFile} is empty or lacks features array`);
                }
            }
            catch (e) {
                console.warn(`[gadm-cache] Failed to read or parse cache from ${cppFile}:`, e);
            }
        }
    }
    console.log(`[gadm-cache] FAILED: Could not match point to any feature in any cache level`);
    return null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ3BrZy1yZWFkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvZ3BrZy1yZWFkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7OztHQVlHO0FBQ0gsT0FBTyxFQUFFLFVBQVUsRUFBRSxZQUFZLEVBQUUsYUFBYSxFQUFFLFNBQVMsRUFBRSxNQUFNLElBQUksQ0FBQztBQUN4RSxPQUFPLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsTUFBTSxNQUFNLENBQUM7QUFDOUMsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLEtBQUssQ0FBQztBQUNwQyxPQUFPLEVBQUUsTUFBTSxFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFDN0MsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDdkQsT0FBTyxLQUFLLElBQUksTUFBTSxZQUFZLENBQUM7QUFDbkMsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLFlBQVksQ0FBQztBQUV0QyxNQUFNLFNBQVMsR0FBRyxhQUFhLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNqRCxNQUFNLFFBQVEsR0FBRyxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUM7QUFvQnBDLHlDQUF5QztBQUV6QyxNQUFNLGtCQUFrQixHQUFHO0lBQ3ZCLHVDQUF1QztJQUN2QyxPQUFPLENBQUMsR0FBRyxDQUFDLGNBQWM7SUFDMUIsNERBQTREO0lBQzVELE9BQU8sQ0FBQyxRQUFRLEVBQUUsdUJBQXVCLENBQUM7SUFDMUMsK0JBQStCO0lBQy9CLE9BQU8sQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFLEVBQUUsb0JBQW9CLENBQUM7SUFDNUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxHQUFHLEVBQUUsRUFBRSwwQkFBMEIsQ0FBQztDQUNyRCxDQUFDO0FBRUYsSUFBSSxTQUFTLEdBQWtCLElBQUksQ0FBQztBQUVwQywrQ0FBK0M7QUFDL0MsTUFBTSxV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