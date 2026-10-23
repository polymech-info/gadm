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
/**
 * Build a hierarchical GADMTree for a region.
 *
 * ```ts
 * const tree = await buildTree({ name: 'Spain', cacheDir: './cache/gadm' });
 * // tree.root.children → 18 comunidades
 * // tree.root.children[5].children → 4 provinces of Cataluña
 * ```
 */
export declare function buildTree(opts: BuildTreeOptions): Promise<GADMTree>;
/**
 * Depth-first walk of the tree. Yields every node top-down.
 *
 * ```ts
 * for (const node of walkDFS(tree.root)) {
 *     console.log('  '.repeat(node.level) + node.name);
 * }
 * ```
 */
export declare function walkDFS(node: GADMNode): Generator<GADMNode>;
/**
 * Breadth-first walk. Yields nodes level by level.
 */
export declare function walkBFS(node: GADMNode): Generator<GADMNode>;
/**
 * Yield only nodes at a specific admin level.
 *
 * ```ts
 * const municipalities = [...walkLevel(tree.root, 4)];
 * ```
 */
export declare function walkLevel(node: GADMNode, level: number): Generator<GADMNode>;
/**
 * Yield only leaf nodes (deepest level, no children).
 */
export declare function leaves(node: GADMNode): Generator<GADMNode>;
/**
 * Find a node by name or GID (case-insensitive). Returns first match via DFS.
 */
export declare function findNode(root: GADMNode, query: string): GADMNode | undefined;
