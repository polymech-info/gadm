/**
 * GADMTree — hierarchical tree built from the flat parquet database.
 *
 * Walk the tree from a country or province down to the deepest GADM level.
 * Cache is optional and directory is supplied by the caller.
 */
import { loadDatabase, type GadmRow } from './database.js';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// ────────── types ──────────

export interface GADMNode {
    /** Display name at this level (e.g. "Barcelona") */
    name: string;
    /** GADM identifier (e.g. "ESP.6.1_1") */
    gid: string;
    /** Administrative level 0-5 */
    level: number;
    /** Child nodes at the next level */
    children: GADMNode[];
}

export interface GADMTree {
    /** Root node (the looked-up area) */
    root: GADMNode;
    /** Deepest level reached */
    maxLevel: number;
    /** Total node count across all levels */
    nodeCount: number;
}

export interface BuildTreeOptions {
    /** Country / region name (e.g. "Spain", "Cataluña") */
    name?: string;
    /** GADM admin code (e.g. "ESP", "ESP.6_1") */
    admin?: string;
    /** Optional cache directory — caller controls location */
    cacheDir?: string;
}

// ────────── cache helpers ──────────

function cacheKey(opts: BuildTreeOptions): string {
    const raw = `tree_${opts.name || ''}_${opts.admin || ''}`;
    return createHash('md5').update(raw).digest('hex');
}

function readCache(dir: string, key: string): GADMTree | null {
    const fp = join(dir, `tree_${key}.json`);
    if (!existsSync(fp)) return null;
    try {
        return JSON.parse(readFileSync(fp, 'utf-8')) as GADMTree;
    } catch {
        return null;
    }
}

function writeCache(dir: string, key: string, tree: GADMTree): void {
    try {
        const fp = join(dir, `tree_${key}.json`);
        mkdirSync(dirname(fp), { recursive: true });
        writeFileSync(fp, JSON.stringify(tree));
    } catch (e) {
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
export async function buildTree(opts: BuildTreeOptions): Promise<GADMTree> {
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
        if (cached) return cached;
    }

    const db = await loadDatabase();

    // ── find root level ──
    const isName = !!opts.name;
    const id = (opts.name || opts.admin)!;
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
    const root: GADMNode = { name: rootName, gid: rootGid, level: rootLevel, children: [] };

    // ── recursively attach children ──
    let nodeCount = 1; // root counts
    nodeCount += attachChildren(root, rows, rootLevel + 1, maxLevel);

    const tree: GADMTree = { root, maxLevel, nodeCount };

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
export function* walkDFS(node: GADMNode): Generator<GADMNode> {
    yield node;
    for (const child of node.children) {
        yield* walkDFS(child);
    }
}

/**
 * Breadth-first walk. Yields nodes level by level.
 */
export function* walkBFS(node: GADMNode): Generator<GADMNode> {
    const queue: GADMNode[] = [node];
    while (queue.length > 0) {
        const current = queue.shift()!;
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
export function* walkLevel(node: GADMNode, level: number): Generator<GADMNode> {
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
export function* leaves(node: GADMNode): Generator<GADMNode> {
    if (node.children.length === 0) {
        yield node;
    } else {
        for (const child of node.children) {
            yield* leaves(child);
        }
    }
}

/**
 * Find a node by name or GID (case-insensitive). Returns first match via DFS.
 */
export function findNode(root: GADMNode, query: string): GADMNode | undefined {
    const q = query.toLowerCase();
    for (const node of walkDFS(root)) {
        if (node.name.toLowerCase() === q || node.gid.toLowerCase() === q) {
            return node;
        }
    }
    return undefined;
}

// ────────── internal helpers ──────────

function eq(a: string | undefined, b: string): boolean {
    if (!a) return false;
    return a.toLowerCase() === b.toLowerCase();
}

function findLevel(db: GadmRow[], colPrefix: string, id: string): number {
    const low = id.toLowerCase();
    for (let l = 0; l < 6; l++) {
        const col = `${colPrefix}${l}`;
        if (db.some(r => r[col]?.toLowerCase() === low)) return l;
    }
    return -1;
}

/**
 * Group `rows` by unique (NAME_level, GID_level), create child GADMNodes,
 * then recurse for each child's subset of rows.
 * Returns the count of nodes added.
 */
function attachChildren(
    parent: GADMNode,
    rows: GadmRow[],
    level: number,
    maxLevel: number,
): number {
    if (level > maxLevel) return 0;

    const nameCol = `NAME_${level}`;
    const gidCol = `GID_${level}`;

    // Deduplicate by GID at this level
    const groups = new Map<string, { name: string; gid: string; rows: GadmRow[] }>();

    for (const r of rows) {
        const gid = r[gidCol];
        const name = r[nameCol];
        if (!gid || gid === '') continue;
        if (!groups.has(gid)) {
            groups.set(gid, { name: name || gid, gid, rows: [] });
        }
        groups.get(gid)!.rows.push(r);
    }

    if (groups.size === 0) return 0;

    let count = 0;
    // Sort children alphabetically by name
    const sorted = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));

    for (const g of sorted) {
        const node: GADMNode = { name: g.name, gid: g.gid, level, children: [] };
        parent.children.push(node);
        count++;
        count += attachChildren(node, g.rows, level + 1, maxLevel);
    }

    return count;
}
