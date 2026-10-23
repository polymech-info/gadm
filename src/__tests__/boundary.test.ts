/**
 * Boundary tests — validates WKB parser reads geometry from local GeoPackage.
 * Results saved to tests/tree/ for inspection.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { getBoundaryFromGpkg } from '../gpkg-reader.js';

const OUT_DIR = resolve('tests', 'tree');

function save(name: string, data: unknown) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, name), JSON.stringify(data, null, 2), 'utf-8');
    console.log(`  → saved tests/tree/${name}`);
}

describe('GeoPackage Boundaries', () => {

    it('reads a country outer boundary (DEU)', async () => {
        const result = await getBoundaryFromGpkg('DEU');

        expect(result).not.toBeNull();
        expect(result!.features.length).toBeGreaterThan(0);

        const f = result!.features[0];
        expect(f.type).toBe('Feature');
        expect(f.geometry.type).toBe('MultiPolygon');
        expect(f.geometry.coordinates.length).toBeGreaterThan(0);

        // Sanity: first coordinate should be in Germany's longitude range (5-16°E)
        const firstCoord = f.geometry.coordinates[0][0][0];
        expect(firstCoord[0]).toBeGreaterThan(4);
        expect(firstCoord[0]).toBeLessThan(16);
        expect(firstCoord[1]).toBeGreaterThan(46);
        expect(firstCoord[1]).toBeLessThan(56);

        console.log(`DEU: ${result!.features.length} features, ${f.geometry.coordinates.length} polygons`);
        console.log(`First coord: [${firstCoord[0].toFixed(4)}, ${firstCoord[1].toFixed(4)}]`);

        // Save a summary (not full geometry — too large)
        save('test-boundary-deu.json', {
            featureCount: result!.features.length,
            geometryType: f.geometry.type,
            polygonCount: f.geometry.coordinates.length,
            firstCoord: firstCoord,
            properties: f.properties,
        });
    }, 120000);

    it('reads a province boundary (ESP.6_1 = Cataluña)', async () => {
        const result = await getBoundaryFromGpkg('ESP.6_1', 1);

        expect(result).not.toBeNull();
        expect(result!.features.length).toBeGreaterThan(0);

        const f = result!.features[0];
        expect(f.geometry.type).toBe('MultiPolygon');

        // Cataluña longitude ~0.1°E to 3.3°E
        const firstCoord = f.geometry.coordinates[0][0][0];
        expect(firstCoord[0]).toBeGreaterThan(-1);
        expect(firstCoord[0]).toBeLessThan(4);

        console.log(`Cataluña: ${f.geometry.coordinates.length} polygons, first coord [${firstCoord[0].toFixed(4)}, ${firstCoord[1].toFixed(4)}]`);

        save('test-boundary-cataluna.json', {
            featureCount: result!.features.length,
            geometryType: f.geometry.type,
            polygonCount: f.geometry.coordinates.length,
            firstCoord: firstCoord,
            properties: f.properties,
        });
    }, 120000);

    it('reads L2 boundaries (DEU.14_1 = Sachsen → districts)', async () => {
        const result = await getBoundaryFromGpkg('DEU.14_1', 2);

        expect(result).not.toBeNull();
        // Sachsen has 13 Kreise
        expect(result!.features.length).toBe(13);

        const names = result!.features.map(f => f.properties.NAME_2).sort();
        expect(names).toContain('Dresden');
        expect(names).toContain('Leipzig');

        console.log(`Sachsen L2: ${result!.features.length} districts: ${names.join(', ')}`);

        save('test-boundary-sachsen-l2.json', {
            featureCount: result!.features.length,
            districts: result!.features.map(f => ({
                name: f.properties.NAME_2,
                gid: f.properties.GID_2,
                polygonCount: f.geometry.coordinates.length,
            })),
        });
    }, 120000);
});
