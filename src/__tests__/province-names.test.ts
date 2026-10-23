/**
 * Exploration test — retrieve all possible names for a province.
 * Given country + province, discover every sub-region at every available level.
 * Saves results to tests/gadm/<country>/<province>.json for inspection.
 */
import { describe, it, expect } from 'vitest';
import { getNames } from '../names.js';
import { getRegionNames } from '../wrapper.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');  // packages/gadm

function saveJson(relPath: string, data: unknown) {
    const abs = join(ROOT, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`  → saved ${relPath} (${JSON.stringify(data).length} bytes)`);
}

describe('Province names exploration', () => {

    it('Spain → find province "Cataluña/Catalonia" and discover its GID', async () => {
        // Step 1: find Spain level-1 sub-regions to discover the province name GADM uses
        const spainL1 = await getNames({ name: 'Spain', contentLevel: 1 });
        console.log(`Spain has ${spainL1.rows.length} level-1 regions`);
        expect(spainL1.rows.length).toBeGreaterThan(10);

        // Find Cataluña — GADM may call it "Cataluña" or "Catalonia"
        const catRow = spainL1.rows.find(
            r => /catalu/i.test(r.NAME_1 || '') || /catalonia/i.test(r.NAME_1 || '')
        );
        console.log('Cataluña row:', catRow);
        expect(catRow).toBeDefined();

        const catGid = catRow!.GID_1!;
        console.log(`Cataluña GID_1 = ${catGid}`);

        // Save Spain's level-1 list
        saveJson('tests/gadm/spain/level1.json', {
            country: 'Spain',
            level: 1,
            count: spainL1.rows.length,
            regions: spainL1.rows,
        });
    });

    it('retrieve ALL sub-region names under Cataluña via its GID', async () => {
        // First find the GID
        const spainL1 = await getNames({ name: 'Spain', contentLevel: 1 });
        const catRow = spainL1.rows.find(
            r => /catalu/i.test(r.NAME_1 || '') || /catalonia/i.test(r.NAME_1 || '')
        );
        expect(catRow).toBeDefined();
        const catGid = catRow!.GID_1!;

        // Step 2: get all names under this GID at each deeper level
        const levels: Record<string, any> = {};

        for (let level = 2; level <= 5; level++) {
            try {
                const result = await getNames({ admin: catGid, contentLevel: level });
                if (result.rows.length === 0) break;
                levels[`level_${level}`] = {
                    count: result.rows.length,
                    columns: result.columns,
                    names: result.rows,
                };
                console.log(`  level ${level}: ${result.rows.length} sub-regions`);
            } catch {
                console.log(`  level ${level}: not available`);
                break;
            }
        }

        // Also try getRegionNames with infinite depth for the full tree
        const allNames = await getRegionNames({
            admin: catGid,
            depth: -1,  // infinite
        });

        const output = {
            country: 'Spain',
            province: catRow!.NAME_1,
            gid: catGid,
            levels,
            allNamesFlat: 'data' in allNames ? allNames.data : [],
            totalCount: 'data' in allNames ? allNames.data.length : 0,
        };

        saveJson('tests/gadm/spain/cataluna.json', output);

        // Sanity: should have at least level-2 data
        expect(Object.keys(levels).length).toBeGreaterThan(0);
        console.log(`\nTotal unique entries across all levels: ${output.totalCount}`);
    });

    it('try direct name lookup for "Catalonia" or "Cataluña"', async () => {
        // Test if getNames can find the province by name directly
        let result;
        try {
            result = await getNames({ name: 'Cataluña' });
            console.log(`Found "Cataluña" at level ${result.level}, ${result.rows.length} rows`);
        } catch (e: any) {
            console.log(`"Cataluña" not found, trying "Catalonia"...`);
            try {
                result = await getNames({ name: 'Catalonia' });
                console.log(`Found "Catalonia" at level ${result.level}, ${result.rows.length} rows`);
            } catch (e2: any) {
                console.log(`Neither found. Error: ${e2.message}`);
            }
        }

        // Now try with contentLevel to get sub-regions
        if (result) {
            const withSubs = await getNames({
                name: result.rows[0]?.[`NAME_${result.level}`],
                contentLevel: result.level + 1,
            });
            console.log(`Sub-regions of province: ${withSubs.rows.length}`);

            saveJson('tests/gadm/spain/cataluna_by_name.json', {
                lookupName: result.rows[0]?.[`NAME_${result.level}`],
                level: result.level,
                subRegionLevel: result.level + 1,
                subRegionCount: withSubs.rows.length,
                subRegions: withSubs.rows,
            });
        }
    });
});
