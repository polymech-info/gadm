/**
 * GADMTree tests — builds trees and saves results to tests/tree/ for inspection.
 */
import { describe, it, expect } from 'vitest';
import { buildTree, findNode, walkDFS, walkLevel, leaves, type GADMNode } from '../tree.js';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const CACHE_DIR = resolve('tests', 'cache', 'gadm');
const OUT_DIR = resolve('tests', 'tree');

function save(name: string, data: unknown) {
    mkdirSync(OUT_DIR, { recursive: true });
    const fp = resolve(OUT_DIR, name);
    writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`  → saved tests/tree/${name}`);
}

describe('GADMTree', () => {

    it('Spain → Cataluña', async () => {
        const tree = await buildTree({ name: 'Cataluña', cacheDir: CACHE_DIR });

        expect(tree.root.name).toBe('Cataluña');
        expect(tree.root.gid).toBe('ESP.6_1');
        expect(tree.root.level).toBe(1);
        expect(tree.maxLevel).toBeGreaterThanOrEqual(4);
        expect(tree.nodeCount).toBeGreaterThan(900);

        // 4 provinces
        expect(tree.root.children.length).toBe(4);
        expect(tree.root.children.map(c => c.name)).toContain('Barcelona');

        // Barcelona sub-regions
        const bcn = tree.root.children.find(c => c.name === 'Barcelona')!;
        expect(bcn.children.length).toBeGreaterThan(5);

        // Leaves = municipalities
        const leafNodes = [...leaves(tree.root)];
        expect(leafNodes.length).toBeGreaterThan(900);

        console.log(`Cataluña: ${tree.nodeCount} nodes, ${leafNodes.length} leaves, max L${tree.maxLevel}`);

        save('test-cataluna.json', tree);
    });

    it('Germany (full country)', async () => {
        const tree = await buildTree({ admin: 'DEU', cacheDir: CACHE_DIR });

        expect(tree.root.name).toBe('Germany');
        expect(tree.root.level).toBe(0);
        expect(tree.root.children.length).toBe(16); // 16 Bundesländer

        console.log(`Germany: ${tree.nodeCount} nodes, ${tree.root.children.length} Bundesländer`);

        save('test-germany-summary.json', {
            name: tree.root.name,
            gid: tree.root.gid,
            maxLevel: tree.maxLevel,
            nodeCount: tree.nodeCount,
            level1: tree.root.children.map(c => ({
                name: c.name,
                gid: c.gid,
                childCount: c.children.length,
            })),
        });
    });

    it('Germany → Sachsen → Dresden', async () => {
        const tree = await buildTree({ admin: 'DEU', cacheDir: CACHE_DIR });

        const sachsen = findNode(tree.root, 'Sachsen');
        expect(sachsen).toBeDefined();
        expect(sachsen!.children.length).toBe(13);

        const dresden = findNode(tree.root, 'Dresden');
        expect(dresden).toBeDefined();

        // Walk subtree
        const nodes = [...walkDFS(dresden!)];
        const leafNodes = [...leaves(dresden!)];

        console.log(`Dresden: ${dresden!.gid}, L${dresden!.level}, ${nodes.length} nodes, ${leafNodes.length} leaves`);
        console.log(`  Sachsen L2: ${sachsen!.children.map(c => c.name).join(', ')}`);

        save('test-dresden.json', {
            sachsen: {
                name: sachsen!.name,
                gid: sachsen!.gid,
                children: sachsen!.children.map(c => c.name),
            },
            dresden: {
                name: dresden!.name,
                gid: dresden!.gid,
                level: dresden!.level,
                totalNodes: nodes.length,
                leaves: leafNodes.map(l => ({ name: l.name, gid: l.gid })),
                children: dresden!.children.map(c => ({
                    name: c.name,
                    gid: c.gid,
                    children: c.children.map(gc => ({ name: gc.name, gid: gc.gid })),
                })),
            },
        });
    });

    it('cache hit is fast', async () => {
        const t0 = Date.now();
        const tree = await buildTree({ name: 'Cataluña', cacheDir: CACHE_DIR });
        const ms = Date.now() - t0;

        expect(tree.root.name).toBe('Cataluña');
        expect(ms).toBeLessThan(500);
        console.log(`Cache hit: ${ms}ms`);
    });

    it('iterators: DFS, walkLevel, findNode', async () => {
        const tree = await buildTree({ name: 'Cataluña', cacheDir: CACHE_DIR });

        // DFS visits every node
        let count = 0;
        for (const _ of walkDFS(tree.root)) count++;
        expect(count).toBe(tree.nodeCount);

        // Level 2 = provinces
        const provinces = [...walkLevel(tree.root, 2)];
        expect(provinces.length).toBe(4);

        // findNode by name
        const bcn = findNode(tree.root, 'Barcelona');
        expect(bcn?.gid).toBe('ESP.6.1_1');

        // findNode by GID
        const girona = findNode(tree.root, 'ESP.6.2_1');
        expect(girona?.name).toBe('Girona');

        save('test-iterators.json', {
            dfsCount: count,
            nodeCount: tree.nodeCount,
            provinces: provinces.map(p => ({ name: p.name, gid: p.gid })),
            barcelona: { name: bcn!.name, gid: bcn!.gid, children: bcn!.children.length },
        });
    });
});
