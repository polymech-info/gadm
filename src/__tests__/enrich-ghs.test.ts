import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { enrichFeatureWithGHS } from '../enrich-ghs.js';
import Database from 'better-sqlite3';
import { parseGpkgGeometry } from '../gpkg-reader.js';

const POP_TIFF_PATH = join(process.cwd(), 'data/ghs/GHS_POP_E2030_GLOBE_R2023A_54009_100_V1_0.tif');
const BUILT_TIFF_PATH = join(process.cwd(), 'data/ghs/GHS_BUILT_S_E2030_GLOBE_R2023A_54009_100_V1_0.tif');

const DEFAULT_GPKG_PATHS = [
    process.env.GADM_GPKG_PATH,
    join(process.cwd(), 'data/gadm_410.gpkg'),
    join(process.cwd(), 'cache/gadm/gadm_410.gpkg'),
    join(__dirname, '../../data/gadm/gadm_410.gpkg'),
    join(__dirname, '../../../../gadm_410.gpkg')
].filter(Boolean) as string[];

const GADM_PATH = DEFAULT_GPKG_PATHS.find(p => existsSync(p));

describe('GHS Enricher', () => {
    it('enriches a geometry feature with population and built areas', async () => {
        if (!existsSync(POP_TIFF_PATH) || !existsSync(BUILT_TIFF_PATH) || !GADM_PATH) {
            console.log('Skipping test as required datasets are missing.');
            return;
        }

        const db = new Database(GADM_PATH, { readonly: true });

        // Fetch Moià
        const moiaRow = db.prepare(`
            SELECT NAME_4, geom 
            FROM gadm_410 
            WHERE NAME_0 = 'Spain' 
              AND (NAME_4 = 'Moià' OR NAME_4 = 'Moia')
            LIMIT 1
        `).get() as any;

        const geometry = parseGpkgGeometry(Buffer.from(moiaRow.geom));

        const feature = {
            type: 'Feature',
            properties: { name: 'Moià' },
            geometry
        };

        const result = await enrichFeatureWithGHS(feature, { pop: true, built: true });

        console.log('\n--- Enrichment Results for Moià ---');
        console.dir(result, { depth: null });

        expect(result.ghsPopulation).toBeGreaterThan(5000);
        expect(result.ghsPopCenter?.length).toBe(2);

        expect(result.ghsBuiltWeight).toBeGreaterThan(0);
        expect(result.ghsBuiltCenter?.length).toBe(2);

        // Map should enrich correctly!

        db.close();
    });

    it('handles batch requests efficiently via memoized TIFF handles', async () => {
        if (!existsSync(POP_TIFF_PATH) || !existsSync(BUILT_TIFF_PATH) || !GADM_PATH) {
            console.log('Skipping test as required datasets are missing.');
            return;
        }

        const db = new Database(GADM_PATH, { readonly: true });
        
        // Fetch 3 municipalities in Barcelona
        const rows = db.prepare(`
            SELECT NAME_4, geom 
            FROM gadm_410 
            WHERE GID_3 = 'ESP.6.1.11_1' 
            LIMIT 3
        `).all() as any[];

        const features = rows.map((r: any) => ({
            type: 'Feature',
            properties: { name: r.NAME_4 },
            geometry: parseGpkgGeometry(Buffer.from(r.geom))
        }));

        db.close();

        // Ensure we load the handles (Cold Cache if first test didn't run, or slightly warm)
        const t0 = Date.now();
        await enrichFeatureWithGHS(features[0] as any, { pop: true, built: true });
        const coldTime = Date.now() - t0;

        // Subsequent Calls (Fully Warm Cache)
        const t1 = Date.now();
        const results = await Promise.all([
            enrichFeatureWithGHS(features[1] as any, { pop: true, built: true }),
            enrichFeatureWithGHS(features[2] as any, { pop: true, built: true })
        ]);
        const warmTime = Date.now() - t1;

        console.log(`\n--- Perf Benchmark: First poly ${coldTime}ms | Next 2 polys combined ${warmTime}ms ---`);
        
        // Verifying it successfully fetched data accurately without racing/blocking
        expect(results[0].ghsPopulation).toBeDefined();
        expect(results[1].ghsBuiltMax).toBeDefined();
        
        // Parallel reads from open TIFF should theoretically be hyper-fast
        // We assert it doesn't exponentially degrade (adding margin for spatial clustering math)
        expect(warmTime).toBeLessThan(coldTime * 3 + 300); 
    });

    it('enriches Tarragona municipalities and exports to JSON', async () => {
        if (!existsSync(POP_TIFF_PATH) || !existsSync(BUILT_TIFF_PATH) || !GADM_PATH) {
            return;
        }

        const db = new Database(GADM_PATH, { readonly: true });
        
        // Fetch a few municipalities in Tarragona
        const rows = db.prepare(`
            SELECT NAME_4, geom 
            FROM gadm_410 
            WHERE GID_2 = 'ESP.6.4_1' AND NAME_4 IS NOT NULL
            LIMIT 3
        `).all() as any[];

        const features = rows.map((r: any) => ({
            type: 'Feature',
            properties: { name: r.NAME_4 },
            geometry: parseGpkgGeometry(Buffer.from(r.geom))
        }));

        db.close();

        for (const feature of features) {
            const enriched = await enrichFeatureWithGHS(feature as any, { pop: true, built: true });
            Object.assign(feature.properties, enriched);
        }

        const featureCollection = {
            type: 'FeatureCollection',
            features
        };

        const outPath = join(__dirname, 'tarragona_enriched.json');
        writeFileSync(outPath, JSON.stringify(featureCollection, null, 2));
        
        expect(existsSync(outPath)).toBe(true);
    });
});
