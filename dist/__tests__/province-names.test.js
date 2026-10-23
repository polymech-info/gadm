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
const ROOT = join(__dirname, '..', '..'); // packages/gadm
function saveJson(relPath, data) {
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
        const catRow = spainL1.rows.find(r => /catalu/i.test(r.NAME_1 || '') || /catalonia/i.test(r.NAME_1 || ''));
        console.log('Cataluña row:', catRow);
        expect(catRow).toBeDefined();
        const catGid = catRow.GID_1;
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
        const catRow = spainL1.rows.find(r => /catalu/i.test(r.NAME_1 || '') || /catalonia/i.test(r.NAME_1 || ''));
        expect(catRow).toBeDefined();
        const catGid = catRow.GID_1;
        // Step 2: get all names under this GID at each deeper level
        const levels = {};
        for (let level = 2; level <= 5; level++) {
            try {
                const result = await getNames({ admin: catGid, contentLevel: level });
                if (result.rows.length === 0)
                    break;
                levels[`level_${level}`] = {
                    count: result.rows.length,
                    columns: result.columns,
                    names: result.rows,
                };
                console.log(`  level ${level}: ${result.rows.length} sub-regions`);
            }
            catch {
                console.log(`  level ${level}: not available`);
                break;
            }
        }
        // Also try getRegionNames with infinite depth for the full tree
        const allNames = await getRegionNames({
            admin: catGid,
            depth: -1, // infinite
        });
        const output = {
            country: 'Spain',
            province: catRow.NAME_1,
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
        }
        catch (e) {
            console.log(`"Cataluña" not found, trying "Catalonia"...`);
            try {
                result = await getNames({ name: 'Catalonia' });
                console.log(`Found "Catalonia" at level ${result.level}, ${result.rows.length} rows`);
            }
            catch (e2) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHJvdmluY2UtbmFtZXMudGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9fX3Rlc3RzX18vcHJvdmluY2UtbmFtZXMudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7OztHQUlHO0FBQ0gsT0FBTyxFQUFFLFFBQVEsRUFBRSxFQUFFLEVBQUUsTUFBTSxFQUFFLE1BQU0sUUFBUSxDQUFDO0FBQzlDLE9BQU8sRUFBRSxRQUFRLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFDdkMsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLGVBQWUsQ0FBQztBQUMvQyxPQUFPLEVBQUUsYUFBYSxFQUFFLFNBQVMsRUFBRSxNQUFNLElBQUksQ0FBQztBQUM5QyxPQUFPLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxNQUFNLE1BQU0sQ0FBQztBQUNyQyxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sS0FBSyxDQUFDO0FBRXBDLE1BQU0sVUFBVSxHQUFHLGFBQWEsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ2xELE1BQU0sU0FBUyxHQUFHLE9BQU8sQ0FBQyxVQUFVLENBQUMsQ0FBQztBQUN0QyxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFFLGdCQUFnQjtBQUUzRCxTQUFTLFFBQVEsQ0FBQyxPQUFlLEVBQUUsSUFBYTtJQUM1QyxNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ2hDLFNBQVMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUUsRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztJQUM3QyxhQUFhLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsRUFBRSxPQUFPLENBQUMsQ0FBQztJQUMzRCxP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