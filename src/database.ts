/**
 * GADM Database — reads the parquet database and provides row-based lookups.
 * Uses hyparquet for zero-native-dep parquet reading.
 */
import { parquetReadObjects } from 'hyparquet';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------- types ----------

export const NAME_COLS = ['NAME_0', 'NAME_1', 'NAME_2', 'NAME_3', 'NAME_4', 'NAME_5'] as const;
export const GID_COLS = ['GID_0', 'GID_1', 'GID_2', 'GID_3', 'GID_4', 'GID_5'] as const;

export type GadmRow = Record<string, string>;

// ---------- paths ----------

const __filename_ = fileURLToPath(import.meta.url);
const __dirname_ = dirname(__filename_);

const PARQUET_CANDIDATES = [
    resolve(process.cwd(), 'data', 'gadm_database.parquet'),          // production: server/data/
    resolve(__dirname_, '../data/gadm_database.parquet'),              // dev: packages/gadm/data/
];

function resolveParquetPath(): string {
    for (const p of PARQUET_CANDIDATES) {
        if (existsSync(p)) {
            return p;
        }
    }
    throw new Error(
        `gadm_database.parquet not found. Tried:\n${PARQUET_CANDIDATES.map(p => `  ${p}`).join('\n')}`,
    );
}

function readFile(): ArrayBuffer {
    const path = resolveParquetPath();
    const buffer = readFileSync(path);
    return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
    );
}

// ---------- lazy cache ----------

let _rows: GadmRow[] | null = null;

/** The data columns we care about (exclude pandas index) */
const DATA_COLUMNS = [
    'GID_0', 'GID_1', 'GID_2', 'GID_3', 'GID_4', 'GID_5',
    'NAME_0', 'NAME_1', 'NAME_2', 'NAME_3', 'NAME_4', 'NAME_5',
];

/**
 * Load the GADM parquet database into memory (lazy, cached).
 * Returns an array of plain objects keyed by column name.
 */
export async function loadDatabase(): Promise<GadmRow[]> {
    if (_rows) return _rows;

    const file = readFile();

    // parquetReadObjects returns proper keyed objects with decoded strings
    const rawObjects = await parquetReadObjects({
        file,
        columns: DATA_COLUMNS,
    }) as Record<string, any>[];

    // Normalize all values to strings (empty string for null/undefined)
    _rows = rawObjects.map(obj => {
        const row: GadmRow = {};
        for (const col of DATA_COLUMNS) {
            const v = obj[col];
            row[col] = v != null ? String(v) : '';
        }
        return row;
    });

    return _rows;
}

/**
 * Get column names.
 */
export function getColumns(): string[] {
    return [...DATA_COLUMNS];
}

/**
 * Reset the cache (useful for testing).
 */
export function resetCache(): void {
    _rows = null;
}
