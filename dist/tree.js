/**
 * GADMTree — hierarchical tree built from the flat parquet database.
 *
 * Walk the tree from a country or province down to the deepest GADM level.
 * Cache is optional and directory is supplied by the caller.
 */
import { loadDatabase } from './database.js';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
// ────────── cache helpers ──────────
function cacheKey(opts) {
    const raw = `tree_${opts.name || ''}_${opts.admin || ''}`;
    return createHash('md5').update(raw).digest('hex');
}
function readCache(dir, key) {
    const fp = join(dir, `tree_${key}.json`);
    if (!existsSync(fp))
        return null;
    try {
        return JSON.parse(readFileSync(fp, 'utf-8'));
    }
    catch {
        return null;
    }
}
function writeCache(dir, key, tree) {
    try {
        const fp = join(dir, `tree_${key}.json`);
        mkdirSync(dirname(fp), { recursive: true });
        writeFileSync(fp, JSON.stringify(tree));
    }
    catch (e) {
        console.error('[GADMTree] cache write failed:', e);
    }
}
// ────────── core ──────────
/**
 * Build a hierarchical GADMTree for a region.
 *
 * ```ts
 * const tree = await buildTree({ name: 'Spain', cacheDir: './cache/gadm' });
 * // tree.root.children → 18 comunidades
 * // tree.root.children[5].children → 4 provinces of Cataluña
 * ```
 */
export async function buildTree(opts) {
    if (!opts.name && !opts.admin) {
        throw new Error('buildTree requires either "name" or "admin".');
    }
    if (opts.name && opts.admin) {
        throw new Error('"name" and "admin" cannot both be set.');
    }
    // ── check cache ──
    const key = cacheKey(opts);
    if (opts.cacheDir) {
        const cached = readCache(opts.cacheDir, key);
        if (cached)
            return cached;
    }
    const db = await loadDatabase();
    // ── find root level ──
    const isName = !!opts.name;
    const id = (opts.name || opts.admin);
    const colPrefix = isName ? 'NAME_' : 'GID_';
    const rootLevel = findLevel(db, colPrefix, id);
    if (rootLevel === -1) {
        throw new Error(`"${id}" not found in GADM database.`);
    }
    // ── filter rows that belong to this root ──
    const col = `${colPrefix}${rootLevel}`;
    const rows = db.filter(r => eq(r[col], id));
    // ── find max available level ──
    let maxLevel = rootLevel;
    for (let l = 5; l > rootLevel; l--) {
        if (rows.some(r => r[`GID_${l}`] && r[`GID_${l}`] !== '')) {
            maxLevel = l;
            break;
        }
    }
    // ── build root node ──
    const rootName = rows[0]?.[`NAME_${rootLevel}`] || id;
    const rootGid = rows[0]?.[`GID_${rootLevel}`] || id;
    const root = { name: rootName, gid: rootGid, level: rootLevel, children: [] };
    // ── recursively attach children ──
    let nodeCount = 1; // root counts
    nodeCount += attachChildren(root, rows, rootLevel + 1, maxLevel);
    const tree = { root, maxLevel, nodeCount };
    // ── persist cache ──
    if (opts.cacheDir) {
        writeCache(opts.cacheDir, key, tree);
    }
    return tree;
}
// ────────── iterators ──────────
/**
 * Depth-first walk of the tree. Yields every node top-down.
 *
 * ```ts
 * for (const node of walkDFS(tree.root)) {
 *     console.log('  '.repeat(node.level) + node.name);
 * }
 * ```
 */
export function* walkDFS(node) {
    yield node;
    for (const child of node.children) {
        yield* walkDFS(child);
    }
}
/**
 * Breadth-first walk. Yields nodes level by level.
 */
export function* walkBFS(node) {
    const queue = [node];
    while (queue.length > 0) {
        const current = queue.shift();
        yield current;
        for (const child of current.children) {
            queue.push(child);
        }
    }
}
/**
 * Yield only nodes at a specific admin level.
 *
 * ```ts
 * const municipalities = [...walkLevel(tree.root, 4)];
 * ```
 */
export function* walkLevel(node, level) {
    if (node.level === level) {
        yield node;
        return; // don't go deeper
    }
    for (const child of node.children) {
        yield* walkLevel(child, level);
    }
}
/**
 * Yield only leaf nodes (deepest level, no children).
 */
export function* leaves(node) {
    if (node.children.length === 0) {
        yield node;
    }
    else {
        for (const child of node.children) {
            yield* leaves(child);
        }
    }
}
/**
 * Find a node by name or GID (case-insensitive). Returns first match via DFS.
 */
export function findNode(root, query) {
    const q = query.toLowerCase();
    for (const node of walkDFS(root)) {
        if (node.name.toLowerCase() === q || node.gid.toLowerCase() === q) {
            return node;
        }
    }
    return undefined;
}
// ────────── internal helpers ──────────
function eq(a, b) {
    if (!a)
        return false;
    return a.toLowerCase() === b.toLowerCase();
}
function findLevel(db, colPrefix, id) {
    const low = id.toLowerCase();
    for (let l = 0; l < 6; l++) {
        const col = `${colPrefix}${l}`;
        if (db.some(r => r[col]?.toLowerCase() === low))
            return l;
    }
    return -1;
}
/**
 * Group `rows` by unique (NAME_level, GID_level), create child GADMNodes,
 * then recurse for each child's subset of rows.
 * Returns the count of nodes added.
 */
function attachChildren(parent, rows, level, maxLevel) {
    if (level > maxLevel)
        return 0;
    const nameCol = `NAME_${level}`;
    const gidCol = `GID_${level}`;
    // Deduplicate by GID at this level
    const groups = new Map();
    for (const r of rows) {
        const gid = r[gidCol];
        const name = r[nameCol];
        if (!gid || gid === '')
            continue;
        if (!groups.has(gid)) {
            groups.set(gid, { name: name || gid, gid, rows: [] });
        }
        groups.get(gid).rows.push(r);
    }
    if (groups.size === 0)
        return 0;
    let count = 0;
    // Sort children alphabetically by name
    const sorted = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const g of sorted) {
        const node = { name: g.name, gid: g.gid, level, children: [] };
        parent.children.push(node);
        count++;
        count += attachChildren(node, g.rows, level + 1, maxLevel);
    }
    return count;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidHJlZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy90cmVlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7OztHQUtHO0FBQ0gsT0FBTyxFQUFFLFlBQVksRUFBZ0IsTUFBTSxlQUFlLENBQUM7QUFDM0QsT0FBTyxFQUFFLFVBQVUsRUFBRSxNQUFNLFFBQVEsQ0FBQztBQUNwQyxPQUFPLEVBQUUsVUFBVSxFQUFFLFlBQVksRUFBRSxhQUFhLEVBQUUsU0FBUyxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBQ3hFLE9BQU8sRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLE1BQU0sTUFBTSxDQUFDO0FBaUNyQyxzQ0FBc0M7QUFFdEMsU0FBUyxRQUFRLENBQUMsSUFBc0I7SUFDcEMsTUFBTSxHQUFHLEdBQUcsUUFBUSxJQUFJLENBQUMsSUFBSSxJQUFJLEVBQUUsSUFBSSxJQUFJLENBQUMsS0FBSyxJQUFJLEVBQUUsRUFBRSxDQUFDO0lBQzFELE9BQU8sVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDdkQsQ0FBQztBQUVELFNBQVMsU0FBUyxDQUFDLEdBQVcsRUFBRSxHQUFXO0lBQ3ZDLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsUUFBUSxHQUFHLE9BQU8sQ0FBQyxDQUFDO0lBQ3pDLElBQUksQ0FBQyxVQUFVLENBQUMsRUFBRSxDQUFDO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDakMsSUFBSSxDQUFDO1FBQ0QsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLFlBQVksQ0FBQyxFQUFFLEVBQUUsT0FBTyxDQUFDLENBQWEsQ0FBQztJQUM3RCxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ0wsT0FBTyxJQUFJLENBQUM7SUFDaEIsQ0FBQztBQUNMLENBQUM7QUFFRCxTQUFTLFVBQVUsQ0FBQyxHQUFXLEVBQUUsR0FBVyxFQUFFLElBQWM7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