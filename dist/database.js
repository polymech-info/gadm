/**
 * GADM Database — reads the parquet database and provides row-based lookups.
 * Uses hyparquet for zero-native-dep parquet reading.
 */
import { parquetReadObjects } from 'hyparquet';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
// ---------- types ----------
export const NAME_COLS = ['NAME_0', 'NAME_1', 'NAME_2', 'NAME_3', 'NAME_4', 'NAME_5'];
export const GID_COLS = ['GID_0', 'GID_1', 'GID_2', 'GID_3', 'GID_4', 'GID_5'];
// ---------- paths ----------
const __filename_ = fileURLToPath(import.meta.url);
const __dirname_ = dirname(__filename_);
const PARQUET_CANDIDATES = [
    resolve(process.cwd(), 'data', 'gadm_database.parquet'), // production: server/data/
    resolve(__dirname_, '../data/gadm_database.parquet'), // dev: packages/gadm/data/
];
function resolveParquetPath() {
    for (const p of PARQUET_CANDIDATES) {
        if (existsSync(p)) {
            return p;
        }
    }
    throw new Error(`gadm_database.parquet not found. Tried:\n${PARQUET_CANDIDATES.map(p => `  ${p}`).join('\n')}`);
}
function readFile() {
    const path = resolveParquetPath();
    const buffer = readFileSync(path);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
// ---------- lazy cache ----------
let _rows = null;
/** In-flight load — prevents stampede when many callers hit getNames at once (e.g. gridsearch list). */
let _loadPromise = null;
/** The data columns we care about (exclude pandas index) */
const DATA_COLUMNS = [
    'GID_0', 'GID_1', 'GID_2', 'GID_3', 'GID_4', 'GID_5',
    'NAME_0', 'NAME_1', 'NAME_2', 'NAME_3', 'NAME_4', 'NAME_5',
];
/**
 * Load the GADM parquet database into memory (lazy, cached).
 * Returns an array of plain objects keyed by column name.
 */
export async function loadDatabase() {
    if (_rows)
        return _rows;
    if (_loadPromise)
        return _loadPromise;
    _loadPromise = (async () => {
        const file = readFile();
        // parquetReadObjects returns proper keyed objects with decoded strings
        const rawObjects = await parquetReadObjects({
            file,
            columns: DATA_COLUMNS,
        });
        // Normalize all values to strings (empty string for null/undefined)
        _rows = rawObjects.map(obj => {
            const row = {};
            for (const col of DATA_COLUMNS) {
                const v = obj[col];
                row[col] = v != null ? String(v) : '';
            }
            return row;
        });
        return _rows;
    })().finally(() => {
        _loadPromise = null;
    });
    return _loadPromise;
}
/**
 * Get column names.
 */
export function getColumns() {
    return [...DATA_COLUMNS];
}
/**
 * Reset the cache (useful for testing).
 */
export function resetCache() {
    _rows = null;
    _loadPromise = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGF0YWJhc2UuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvZGF0YWJhc2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7OztHQUdHO0FBQ0gsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQy9DLE9BQU8sRUFBRSxZQUFZLEVBQUUsVUFBVSxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBQzlDLE9BQU8sRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sTUFBTSxDQUFDO0FBQ3hDLE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFFcEMsOEJBQThCO0FBRTlCLE1BQU0sQ0FBQyxNQUFNLFNBQVMsR0FBRyxDQUFDLFFBQVEsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsUUFBUSxDQUFVLENBQUM7QUFDL0YsTUFBTSxDQUFDLE1BQU0sUUFBUSxHQUFHLENBQUMsT0FBTyxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLE9BQU8sRUFBRSxPQUFPLENBQVUsQ0FBQztBQUl4Riw4QkFBOEI7QUFFOUIsTUFBTSxXQUFXLEdBQUcsYUFBYSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDbkQsTUFBTSxVQUFVLEdBQUcsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBRXhDLE1BQU0sa0JBQWtCLEdBQUc7SUFDdkIsT0FBTyxDQUFDLE9BQU8sQ0FBQyxHQUFHLEVBQUUsRUFBRSxNQUFNLEVBQUUsdUJBQXVCLENBQUMsRUFBVywyQkFBMkI7SUFDN0YsT0FBTyxDQUFDLFVBQVUsRUFBRSwrQkFBK0IsQ0FBQyxFQUFlLDJCQUEyQjtDQUNqRyxDQUFDO0FBRUYsU0FBUyxrQkFBa0I7SUFDdkIsS0FBSyxNQUFNLENBQUMsSUFBSSxrQkFBa0IsRUFBRSxDQUFDO1FBQ2pDLElBQUksVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFFLENB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