/**
 * Names lookup — port of Python pygadm.Names class.
 *
 * Searches the GADM parquet database for admin areas by name or GID code.
 * Returns matching rows with NAME_{level} and GID_{level} columns.
 */
import { loadDatabase, type GadmRow } from './database.js';

// ---------- types ----------

export interface NamesOptions {
    /** Administrative area name (cannot use with `admin`) */
    name?: string;
    /** GADM admin code like "FRA" or "ESP.6_1" (cannot use with `name`) */
    admin?: string;
    /** Target content level (0-5). -1 = auto-detect from the matched area */
    contentLevel?: number;
    /** If true, return all columns. If false, only NAME_{level} and GID_{level} */
    complete?: boolean;
}

export interface NamesResult {
    /** The matched/filtered rows */
    rows: GadmRow[];
    /** The resolved content level */
    level: number;
    /** Column names in the result */
    columns: string[];
}

// ---------- helpers ----------

/** Simple Levenshtein distance for fuzzy matching */
function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

/** Find the N closest matches to `query` from a list of candidates */
function closestMatches(query: string, candidates: string[], n = 5): string[] {
    const q = query.toLowerCase();
    const scored = candidates.map(c => ({ val: c, dist: levenshtein(q, c.toLowerCase()) }));
    scored.sort((a, b) => a.dist - b.dist);
    return scored.slice(0, n).map(s => s.val);
}

// ---------- main function ----------

/**
 * Look up administrative area names/codes in the GADM database.
 *
 * Port of Python `pygadm.Names(name, admin, content_level, complete)`.
 */
export async function getNames(opts: NamesOptions = {}): Promise<NamesResult> {
    const { name, admin, contentLevel: rawContentLevel = -1, complete = false } = opts;

    if (name && admin) {
        throw new Error('"name" and "admin" cannot be set at the same time.');
    }

    const db = await loadDatabase();
    let contentLevel = rawContentLevel;

    if (name || admin) {
        const isName = !!name;
        const id = (name || admin)!;
        const colPrefix = isName ? 'NAME_' : 'GID_';

        // Search all 6 levels for the id
        const matchedLevel = findLevel(db, colPrefix, id);

        if (matchedLevel === -1) {
            // Not found — suggest closest matches
            const allIds = collectAllIds(db, colPrefix);
            const close = closestMatches(id, allIds, 5);
            const formatted = isName
                ? close.map(c => capitalize(c))
                : close.map(c => c.toUpperCase());
            throw new Error(
                `The requested "${id}" is not part of GADM. ` +
                `The closest matches are: ${formatted.join(', ')}.`
            );
        }

        const level = matchedLevel;

        // Filter to rows matching this id at the found level
        const col = `${colPrefix}${level}`;
        let subDf = db.filter(r => caseEqual(r[col], id));

        // Find max available level in this subset
        const maxLevel = findMaxLevel(subDf);

        // Resolve content level
        if (contentLevel === -1) {
            contentLevel = level;
        } else if (contentLevel < level) {
            // Requested level higher than area — fallback
            contentLevel = level;
        }
        if (contentLevel > maxLevel) {
            contentLevel = maxLevel;
        }

        // Deduplicate at content level
        const nameCol = `NAME_${contentLevel}`;
        const gidCol = `GID_${contentLevel}`;
        const seen = new Set<string>();
        subDf = subDf.filter(r => {
            if (!r[nameCol]) return false; // skip empty
            const key = `${r[nameCol]}|${r[gidCol]}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Select columns
        const columns = complete
            ? ['NAME_0', 'GID_0', 'NAME_1', 'GID_1', 'NAME_2', 'GID_2', 'NAME_3', 'GID_3', 'NAME_4', 'GID_4', 'NAME_5', 'GID_5']
                .filter((_, i) => Math.floor(i / 2) <= contentLevel)
            : [nameCol, gidCol];

        const rows = complete ? subDf : subDf.map(r => {
            const out: GadmRow = {};
            for (const c of columns) out[c] = r[c] ?? '';
            return out;
        });

        return { rows, level: contentLevel, columns };
    }

    // No name/admin — return world-level data
    contentLevel = contentLevel === -1 ? 0 : contentLevel;
    const nameCol = `NAME_${contentLevel}`;
    const gidCol = `GID_${contentLevel}`;

    const seen = new Set<string>();
    const rows = db.filter(r => {
        if (!r[nameCol]) return false;
        const key = `${r[nameCol]}|${r[gidCol]}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const columns = [nameCol, gidCol];
    const filtered = rows.map(r => {
        const out: GadmRow = {};
        for (const c of columns) out[c] = r[c] ?? '';
        return out;
    });

    return { rows: filtered, level: contentLevel, columns };
}

// ---------- internal helpers ----------

function caseEqual(a: string | undefined, b: string): boolean {
    if (!a) return false;
    return a.toLowerCase() === b.toLowerCase();
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Find which level (0-5) contains the given id */
function findLevel(db: GadmRow[], colPrefix: string, id: string): number {
    const idLower = id.toLowerCase();
    for (let level = 0; level < 6; level++) {
        const col = `${colPrefix}${level}`;
        if (db.some(r => r[col]?.toLowerCase() === idLower)) {
            return level;
        }
    }
    return -1;
}

/** Collect all unique ids across all levels for fuzzy matching */
function collectAllIds(db: GadmRow[], colPrefix: string): string[] {
    const ids = new Set<string>();
    for (let level = 0; level < 6; level++) {
        const col = `${colPrefix}${level}`;
        for (const r of db) {
            if (r[col]) ids.add(r[col].toLowerCase());
        }
    }
    return [...ids];
}

/** Find the maximum level that has non-empty data */
function findMaxLevel(rows: GadmRow[]): number {
    for (let level = 5; level >= 0; level--) {
        const col = `GID_${level}`;
        if (rows.some(r => r[col] && r[col] !== '')) {
            return level;
        }
    }
    return 0;
}
