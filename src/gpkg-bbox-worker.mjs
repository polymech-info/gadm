/**
 * Worker thread for GeoPackage bbox → GID queries.
 * Keeps better-sqlite3 sync work off the Node HTTP event loop.
 */
import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

let db = null;
let tableName = '';

function ensureDb(gpkgPath) {
    if (db) return true;
    if (!gpkgPath || !existsSync(gpkgPath)) return false;
    const Database = require('better-sqlite3');
    db = new Database(gpkgPath, { readonly: true, fileMustExist: true });
    const tables = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'gpkg_%' AND name NOT LIKE 'rtree_%' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
    tableName = tables.find((t) => t.name === 'gadm_410' || t.name === 'gadm41_raw')?.name;
    if (!tableName) {
        db.close();
        db = null;
        return false;
    }
    return true;
}

function queryUniqueGidsInBbox(bbox, level) {
    if (level < 0 || level > 5) return [];
    const [minx, miny, maxx, maxy] = bbox;
    const gidCol = `GID_${level}`;
    const nameCol = `NAME_${level}`;
    const rows = db
        .prepare(
            `SELECT DISTINCT a."${gidCol}" AS gid, a."${nameCol}" AS name
             FROM "${tableName}" a
             JOIN "rtree_${tableName}_geom" b ON a.fid = b.id
             WHERE b.maxx >= ? AND b.minx <= ? AND b.maxy >= ? AND b.miny <= ?
               AND a."${gidCol}" IS NOT NULL`,
        )
        .all(minx, maxx, miny, maxy);

    const out = [];
    const seen = new Set();
    for (const r of rows) {
        if (!r?.gid || typeof r.gid !== 'string') continue;
        if (seen.has(r.gid)) continue;
        seen.add(r.gid);
        out.push({ gid: r.gid, name: typeof r.name === 'string' ? r.name : r.gid });
    }
    return out;
}

parentPort.on('message', (msg) => {
    const { id, gpkgPath, bbox, level } = msg || {};
    try {
        if (!ensureDb(gpkgPath)) {
            parentPort.postMessage({ id, ok: true, hits: [] });
            return;
        }
        const hits = queryUniqueGidsInBbox(bbox, level);
        parentPort.postMessage({ id, ok: true, hits });
    } catch (err) {
        parentPort.postMessage({
            id,
            ok: false,
            error: err?.message || String(err),
        });
    }
});
