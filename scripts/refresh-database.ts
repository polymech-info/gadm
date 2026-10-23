#!/usr/bin/env npx tsx
/**
 * refresh-database.ts — TypeScript port of pygadm/bin/refresh_database.py
 *
 * Reads GADM GeoPackage (SQLite), extracts GID/NAME/VARNAME columns from
 * all ADM layers (0-5), writes a Parquet database file.
 *
 * Usage:
 *   npx tsx scripts/refresh-database.ts                                # uses default path
 *   npx tsx scripts/refresh-database.ts -f server/cache/gadm/file.gpkg # explicit path
 *
 * Default lookup order:
 *   1. server/cache/gadm/gadm_410-raw.gpkg
 *   2. server/cache/gadm/gadm_410-levels.gpkg  (from the zip)
 *   3. data/gadm_database.gpkg (local fallback)
 */

import Database from 'better-sqlite3';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { existsSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ────────── constants ──────────

const GADM_VERSION = '410'; // 4.1

const __filename_ = fileURLToPath(import.meta.url);
const __dirname_ = dirname(__filename_);
const PKG_ROOT = resolve(__dirname_, '..');
const MONO_ROOT = resolve(PKG_ROOT, '..', '..');
const DATA_DIR = resolve(PKG_ROOT, 'data');
const OUTPUT_FILE = resolve(DATA_DIR, 'gadm_database.parquet');

/** Default locations to look for the gpkg */
const DEFAULT_GPKG_PATHS = [
    resolve(MONO_ROOT, 'server', 'cache', 'gadm', `gadm_${GADM_VERSION}.gpkg`),
    resolve(MONO_ROOT, 'server', 'cache', 'gadm', `gadm_${GADM_VERSION}-raw.gpkg`),
    resolve(MONO_ROOT, 'server', 'cache', 'gadm', `gadm_${GADM_VERSION}-levels.gpkg`),
    resolve(DATA_DIR, 'gadm_database.gpkg'),
];

/** Columns to extract — now includes VARNAME for English/alternate names */
const GID_COLS = ['GID_0', 'GID_1', 'GID_2', 'GID_3', 'GID_4', 'GID_5'];
const NAME_COLS = ['NAME_0', 'NAME_1', 'NAME_2', 'NAME_3', 'NAME_4', 'NAME_5'];
const VARNAME_COLS = ['VARNAME_1', 'VARNAME_2', 'VARNAME_3', 'VARNAME_4', 'VARNAME_5'];
const ALL_COLS = [...GID_COLS, ...NAME_COLS, ...VARNAME_COLS];

// ────────── helpers ──────────

function log(msg: string) {
    process.stdout.write(`[refresh-database] ${msg}\n`);
}

/**
 * Read a GeoPackage layer (ADM_0..ADM_5) using better-sqlite3.
 * GeoPackage is just SQLite with OGC extensions — each layer is a table.
 */
function readLayer(db: Database.Database, layerName: string): Record<string, string>[] {
    const tableName = `"${layerName}"`;

    // Check if table exists
    const tableCheck = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
    ).get(layerName) as { name: string } | undefined;

    if (!tableCheck) {
        log(`  ⚠ Table ${layerName} not found, skipping`);
        return [];
    }

    // Get available column names
    const pragma = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
    const availableCols = new Set(pragma.map(p => p.name));

    // Build SELECT — map COUNTRY → NAME_0 (GADM uses COUNTRY in ADM_0)
    const selectParts: string[] = [];
    const outputCols: string[] = [];

    for (const col of ALL_COLS) {
        if (col === 'NAME_0' && !availableCols.has('NAME_0') && availableCols.has('COUNTRY')) {
            selectParts.push(`"COUNTRY" AS "NAME_0"`);
            outputCols.push('NAME_0');
        } else if (availableCols.has(col)) {
            selectParts.push(`"${col}"`);
            outputCols.push(col);
        }
    }

    if (selectParts.length === 0) {
        log(`  ⚠ Layer ${layerName} has no relevant columns, skipping`);
        return [];
    }

    const sql = `SELECT ${selectParts.join(', ')} FROM ${tableName}`;
    const rows = db.prepare(sql).all() as Record<string, any>[];

    // Normalize: fill missing cols with ''
    return rows.map(row => {
        const out: Record<string, string> = {};
        for (const col of ALL_COLS) {
            const val = row[col];
            out[col] = val != null ? String(val) : '';
        }
        return out;
    });
}

// ────────── main ──────────

function main() {
    const args = process.argv.slice(2);
    let gpkgPath: string | undefined;

    // Parse -f flag
    const fIdx = args.indexOf('-f');
    if (fIdx !== -1 && args[fIdx + 1]) {
        gpkgPath = resolve(args[fIdx + 1]);
        if (!existsSync(gpkgPath)) {
            throw new Error(`File not found: ${gpkgPath}`);
        }
    } else {
        // Try default paths
        for (const p of DEFAULT_GPKG_PATHS) {
            if (existsSync(p)) {
                gpkgPath = p;
                break;
            }
        }
    }

    if (!gpkgPath) {
        log('ERROR: No GeoPackage found. Looked in:');
        for (const p of DEFAULT_GPKG_PATHS) {
            log(`  ${p}`);
        }
        log('Download from: https://geodata.ucdavis.edu/gadm/gadm4.1/gadm_410-gpkg.zip');
        log('  → unzip and place in server/cache/gadm/');
        log('Or use: npx tsx scripts/refresh-database.ts -f /path/to/file.gpkg');
        process.exit(1);
    }

    log(`Using: ${gpkgPath}`);
    log(`Size: ${(statSync(gpkgPath).size / 1024 / 1024).toFixed(1)} MB`);

    // Open the GeoPackage (read-only SQLite)
    log('Opening GeoPackage...');
    const db = new Database(gpkgPath, { readonly: true });

    // Find all user tables (skip sqlite/gpkg system tables)
    const allTables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'gpkg_%' AND name NOT LIKE 'rtree_%'`
    ).all() as { name: string }[];
    const tableNames = allTables.map(t => t.name);
    log(`Tables found: ${tableNames.join(', ')}`);

    // Try per-level ADM_0..ADM_5 first (the "levels" gpkg)
    const admTables = tableNames.filter(n => /^ADM_\d+$/i.test(n));

    const allRows: Record<string, string>[] = [];

    if (admTables.length > 0) {
        log(`Found per-level tables: ${admTables.join(', ')}`);
        for (let level = 0; level <= 5; level++) {
            const layerName = `ADM_${level}`;
            log(`Reading layer ${layerName}...`);
            const rows = readLayer(db, layerName);
            log(`  → ${rows.length} rows`);
            allRows.push(...rows);
        }
    } else {
        // Flat table format — gadm_410 or gadm41_raw
        // Pick the first non-system table
        const flatTable = tableNames[0];
        if (!flatTable) {
            log('ERROR: No data tables found in GeoPackage!');
            db.close();
            process.exit(1);
        }

        log(`Using flat table: ${flatTable}`);

        // Get columns
        const pragma = db.prepare(`PRAGMA table_info("${flatTable}")`).all() as { name: string }[];
        const availableCols = new Set(pragma.map(p => p.name));
        log(`Available columns (${availableCols.size}): ${[...availableCols].filter(c => /^(GID|NAME|VARNAME|COUNTRY)/i.test(c)).join(', ')}`);

        // Build SELECT for all needed columns
        const selectParts: string[] = [];
        for (const col of ALL_COLS) {
            if (col === 'NAME_0' && !availableCols.has('NAME_0') && availableCols.has('COUNTRY')) {
                selectParts.push(`"COUNTRY" AS "NAME_0"`);
            } else if (availableCols.has(col)) {
                selectParts.push(`"${col}"`);
            } else {
                selectParts.push(`'' AS "${col}"`);
            }
        }

        const sql = `SELECT ${selectParts.join(', ')} FROM "${flatTable}"`;
        log(`Querying... (this may take a moment for large files)`);
        const rows = db.prepare(sql).all() as Record<string, any>[];
        log(`  → ${rows.length} rows`);

        for (const row of rows) {
            const out: Record<string, string> = {};
            for (const col of ALL_COLS) {
                const val = row[col];
                out[col] = val != null ? String(val) : '';
            }
            allRows.push(out);
        }
    }

    db.close();
    log(`Total rows: ${allRows.length}`);

    if (allRows.length === 0) {
        log('ERROR: No data read! Check the GeoPackage file.');
        process.exit(1);
    }

    // Show sample VARNAME data
    const withVarname = allRows.filter(r => r.VARNAME_1 && r.VARNAME_1 !== '');
    log(`Rows with VARNAME_1: ${withVarname.length}`);
    if (withVarname.length > 0) {
        const sample = withVarname.slice(0, 3);
        for (const s of sample) {
            log(`  ${s.NAME_1} → VARNAME: ${s.VARNAME_1}`);
        }
    }

    // Build columnar data for parquet writer
    log('Building parquet columns...');
    const columnData = ALL_COLS.map(col => ({
        name: col,
        data: allRows.map(r => r[col] || ''),
    }));

    log('Writing parquet...');
    mkdirSync(DATA_DIR, { recursive: true });

    const buffer = parquetWriteBuffer({ columnData });
    const bytes = Buffer.from(buffer);
    writeFileSync(OUTPUT_FILE, bytes);

    log('');
    log(`✔ Done!`);
    log(`  File: ${OUTPUT_FILE}`);
    log(`  Size: ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
    log(`  Rows: ${allRows.length}`);
    log(`  Cols: ${ALL_COLS.join(', ')}`);
}

main();

