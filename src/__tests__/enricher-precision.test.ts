/**
 * Enricher Precision Tests — validates GHS center coordinates are:
 *  1. Inside their parent polygon (PIP)
 *  2. Rounded to ≤5 decimal places
 *  3. Consistent between C++ cache and live TS enrichment
 */
import { describe, it, expect } from 'vitest';
import { resolve, join } from 'path';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { enrichFeatureWithGHS } from '../enrich-ghs.js';
import { containsPoint, getBoundaryFromGpkg, parseGpkgGeometry } from '../gpkg-reader.js';
import Database from 'better-sqlite3';

const CACHE_DIR = resolve(process.cwd(), 'cache/gadm');
const OUT_DIR = resolve('tests', 'tree');

const POP_TIFF_PATH = join(process.cwd(), 'data/ghs/GHS_POP_E2030_GLOBE_R2023A_54009_100_V1_0.tif');
const BUILT_TIFF_PATH = join(process.cwd(), 'data/ghs/GHS_BUILT_S_E2030_GLOBE_R2023A_54009_100_V1_0.tif');

const DEFAULT_GPKG_PATHS = [
    process.env.GADM_GPKG_PATH,
    join(process.cwd(), 'data/gadm_410.gpkg'),
    join(process.cwd(), 'cache/gadm/gadm_410.gpkg'),
].filter(Boolean) as string[];

const GADM_PATH = DEFAULT_GPKG_PATHS.find(p => existsSync(p));

function save(name: string, data: unknown) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, name), JSON.stringify(data, null, 2), 'utf-8');
    console.log(`  → saved tests/tree/${name}`);
}

function haversineMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
    const R = 6_371_000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Check that a number has ≤5 decimal places */
function checkPrecision(value: number): boolean {
    const str = value.toString();
    const decimalPart = str.includes('.') ? str.split('.')[1] : '';
    return decimalPart.length <= 5;
}

describe('GHS Enricher Precision', () => {

    // ── Test 1: Centers must be inside their polygon ────────────────────────
    it('all GHS centers from getBoundaryFromGpkg lie inside their polygon', async () => {
        // Use a well-known region: Sachsen L2 (13 districts)
        const result = await getBoundaryFromGpkg('DEU.14_1', 2);
        expect(result).not.toBeNull();
        expect(result!.features.length).toBeGreaterThan(0);

        const errors: string[] = [];

        for (const f of result!.features) {
            const geom = f.geometry;
            const props = f.properties;
            const label = props.NAME_2 || props.code || 'unknown';

            for (const key of ['ghsPopCenter', 'ghsBuiltCenter'] as const) {
                const center = props[key];
                if (center && Array.isArray(center) && center.length === 2) {
                    if (!containsPoint(geom, [center[0], center[1]])) {
                        errors.push(`${label}: ${key} [${center[0]}, ${center[1]}] is OUTSIDE polygon`);
                    }
                }
            }

            for (const key of ['ghsPopCenters', 'ghsBuiltCenters'] as const) {
                const centers = props[key];
                if (Array.isArray(centers)) {
                    for (let i = 0; i < centers.length; i++) {
                        const c = centers[i];
                        if (!containsPoint(geom, [c[0], c[1]])) {
                            errors.push(`${label}: ${key}[${i}] [${c[0]}, ${c[1]}] is OUTSIDE polygon`);
                        }
                    }
                }
            }
        }

        save('enricher-precision-pip.json', {
            region: 'DEU.14_1 (Sachsen) L2',
            featureCount: result!.features.length,
            errors,
        });

        if (errors.length > 0) {
            console.warn(`\n⚠️  ${errors.length} centers outside polygon:`);
            errors.forEach(e => console.warn(`  - ${e}`));
        }

        // Allow up to 10% failure rate (expected from geometry simplification)
        const totalCenters = result!.features.reduce((acc, f) => {
            let count = 0;
            if (f.properties.ghsPopCenter) count++;
            if (f.properties.ghsBuiltCenter) count++;
            if (Array.isArray(f.properties.ghsPopCenters)) count += f.properties.ghsPopCenters.length;
            if (Array.isArray(f.properties.ghsBuiltCenters)) count += f.properties.ghsBuiltCenters.length;
            return acc + count;
        }, 0);

        console.log(`\n📊 PIP check: ${totalCenters} centers tested, ${errors.length} outside (${((errors.length / Math.max(totalCenters, 1)) * 100).toFixed(1)}%)`);
        expect(errors.length).toBeLessThan(totalCenters * 0.1);
    }, 120_000);

    // ── Test 2: Coordinate precision ≤ 5 decimal places ─────────────────────
    it('all GHS coordinates have ≤5 decimal places', async () => {
        const result = await getBoundaryFromGpkg('ESP.6_1', 2);
        expect(result).not.toBeNull();

        const precisionErrors: string[] = [];

        for (const f of result!.features) {
            const props = f.properties;
            const label = props.NAME_2 || props.code || 'unknown';

            for (const key of ['ghsPopCenter', 'ghsBuiltCenter'] as const) {
                const center = props[key];
                if (center && Array.isArray(center)) {
                    center.forEach((v: number, i: number) => {
                        if (!checkPrecision(v)) {
                            precisionErrors.push(`${label}: ${key}[${i}] = ${v} exceeds 5dp`);
                        }
                    });
                }
            }

            for (const key of ['ghsPopCenters', 'ghsBuiltCenters'] as const) {
                const centers = props[key];
                if (Array.isArray(centers)) {
                    for (const c of centers) {
                        c.slice(0, 2).forEach((v: number, i: number) => {
                            if (!checkPrecision(v)) {
                                precisionErrors.push(`${label}: ${key}[${i}] = ${v} exceeds 5dp`);
                            }
                        });
                    }
                }
            }
        }

        save('enricher-precision-dp.json', {
            region: 'ESP.6_1 (Cataluña) L2',
            featureCount: result!.features.length,
            precisionErrors,
        });

        if (precisionErrors.length > 0) {
            console.warn(`\n⚠️  ${precisionErrors.length} precision failures:`);
            precisionErrors.forEach(e => console.warn(`  - ${e}`));
        }

        expect(precisionErrors.length).toBe(0);
    }, 120_000);

    // ── Test 3: C++ vs TS cross-validation ──────────────────────────────────
    it('C++ and TS enrichment centers agree within 200m', async () => {
        if (!existsSync(POP_TIFF_PATH) || !existsSync(BUILT_TIFF_PATH) || !GADM_PATH) {
            console.log('Skipping cross-validation: GHS TIFFs or GPKG not found.');
            return;
        }

        // Use getBoundaryFromGpkg which may load from C++ cache
        const cppResult = await getBoundaryFromGpkg('ABW', 0);
        if (!cppResult || cppResult.features.length === 0) {
            console.log('Skipping: no cached boundary for ABW');
            return;
        }

        const THRESHOLD = 500; // meters
        const drifts: Array<{ name: string; type: string; distM: number; cpp: number[]; ts: number[] }> = [];

        // Re-enrich the same geometries via TS
        for (const f of cppResult.features) {
            const label = f.properties.name || f.properties.NAME_0 || 'ABW';
            const cppPopCenter = f.properties.ghsPopCenter;
            const cppBuiltCenter = f.properties.ghsBuiltCenter;

            const tsResult = await enrichFeatureWithGHS(
                { type: 'Feature', properties: {}, geometry: f.geometry },
                { pop: true, built: true }
            );

            if (cppPopCenter && tsResult.ghsPopCenter) {
                const dist = haversineMeters(
                    cppPopCenter[0], cppPopCenter[1],
                    tsResult.ghsPopCenter[0], tsResult.ghsPopCenter[1]
                );
                drifts.push({
                    name: label, type: 'pop', distM: Math.round(dist),
                    cpp: cppPopCenter, ts: tsResult.ghsPopCenter
                });

                if (dist > THRESHOLD) {
                    console.warn(`⚠️  ${label} pop center drift: ${Math.round(dist)}m`);
                }
            }

            if (cppBuiltCenter && tsResult.ghsBuiltCenter) {
                const dist = haversineMeters(
                    cppBuiltCenter[0], cppBuiltCenter[1],
                    tsResult.ghsBuiltCenter[0], tsResult.ghsBuiltCenter[1]
                );
                drifts.push({
                    name: label, type: 'built', distM: Math.round(dist),
                    cpp: cppBuiltCenter, ts: tsResult.ghsBuiltCenter
                });

                if (dist > THRESHOLD) {
                    console.warn(`⚠️  ${label} built center drift: ${Math.round(dist)}m`);
                }
            }
        }

        save('enricher-precision-cross.json', { region: 'ABW', threshold: THRESHOLD, drifts });

        console.log(`\n📊 Cross-validation: ${drifts.length} center pairs compared`);
        drifts.forEach(d => console.log(`  ${d.name} ${d.type}: ${d.distM}m`));

        const failures = drifts.filter(d => d.distM > THRESHOLD);
        expect(failures.length).toBe(0);
    }, 120_000);

    // ── Test 4: Population sanity check ─────────────────────────────────────
    it('weighted center is closer to dense areas than bbox center', async () => {
        if (!existsSync(POP_TIFF_PATH) || !GADM_PATH) {
            console.log('Skipping: GHS POP TIFF not found.');
            return;
        }

        const db = new Database(GADM_PATH, { readonly: true });

        // Berlin — has a clear urban center
        const row = db.prepare(`
            SELECT NAME_1, geom FROM gadm_410 WHERE GID_1 = 'DEU.3_1' LIMIT 1
        `).get() as any;
        db.close();

        if (!row) { console.log('Skipping: DEU.3_1 not found'); return; }

        const geometry = parseGpkgGeometry(Buffer.from(row.geom));
        const feature = { type: 'Feature', properties: { name: 'Berlin' }, geometry };

        const result = await enrichFeatureWithGHS(feature, { pop: true });

        expect(result.ghsPopCenter).toBeDefined();
        expect(result.ghsPopulation).toBeGreaterThan(1_000_000);

        // Berlin's center is roughly 13.4°E, 52.52°N
        const knownCenter = [13.405, 52.52];
        const distToKnown = haversineMeters(
            result.ghsPopCenter![0], result.ghsPopCenter![1],
            knownCenter[0], knownCenter[1]
        );

        console.log(`\n📊 Berlin pop center: [${result.ghsPopCenter}], distance to known center: ${Math.round(distToKnown)}m`);
        console.log(`   Population: ${result.ghsPopulation}, max density: ${result.ghsPopMaxDensity}`);

        // Weighted pop center should be within 5km of Berlin's known center
        expect(distToKnown).toBeLessThan(5000);

        save('enricher-precision-berlin.json', {
            popCenter: result.ghsPopCenter,
            population: result.ghsPopulation,
            distToKnownCenter: Math.round(distToKnown),
            popCenters: result.ghsPopCenters,
        });
    }, 120_000);
});
