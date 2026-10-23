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
 * Used as a fast candidate set for neighbor detection (esp. L0).
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ3BrZy1yZWFkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvZ3BrZy1yZWFkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7OztHQVlHO0FBQ0gsT0FBTyxFQUFFLFVBQVUsRUFBRSxZQUFZLEVBQUUsYUFBYSxFQUFFLFNBQVMsRUFBRSxNQUFNLElBQUksQ0FBQztBQUN4RSxPQUFPLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsTUFBTSxNQUFNLENBQUM7QUFDOUMsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLEtBQUssQ0FBQztBQUNwQyxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQUN2RCxPQUFPLEtBQUssSUFBSSxNQUFNLFlBQVksQ0FBQztBQUNuQyxPQUFPLEVBQUUsUUFBUSxFQUFFLE1BQU0sWUFBWSxDQUFDO0FBRXRDLE1BQU0sU0FBUyxHQUFHLGFBQWEsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ2pELE1BQU0sUUFBUSxHQUFHLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQztBQW9CcEMseUNBQXlDO0FBRXpDLE1BQU0sa0JBQWtCLEdBQUc7SUFDdkIsdUNBQXVDO0lBQ3ZDLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBYztJQUMxQiw0REFBNEQ7SUFDNUQsT0FBTyxDQUFDLFFBQVEsRUFBRSx1QkFBdUIsQ0FBQztJQUMxQywrQkFBK0I7SUFDL0IsT0FBTyxDQUFDLE9BQU8sQ0FBQyxHQUFHLEVBQUUsRUFBRSxvQkFBb0IsQ0FBQztJQUM1QyxPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxFQUFFLDBCQUEwQixDQUFDO0NBQ3JELENBQUM7QUFFRixJQUFJLFNBQVMsR0FBa0IsSUFBSSxDQUFDO0FBRXBDLCtDQUErQztBQUMvQyxNQUFNLFVBQVUsV0FBVyxDQUFDLENBQVM7SUFDakMsU0FBUyxHQUFHLENBQUMsQ0FB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