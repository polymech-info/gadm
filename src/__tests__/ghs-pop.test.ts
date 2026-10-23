import { describe, it, expect } from 'vitest';
import * as geotiff from 'geotiff';
import { resolve } from 'path';
import * as path from 'path';
import { existsSync, writeFileSync } from 'fs';

const POP_TIFF_PATH = path.join(process.cwd(), 'data/ghs/GHS_POP_E2030_GLOBE_R2023A_54009_100_V1_0.tif');

describe('GHS Population GeoTIFF', () => {
    it('finds Moia populated center based on real population', async () => {
        if (!existsSync(POP_TIFF_PATH)) {
            console.log(`Skipping Test: GHS_POP GeoTIFF not found at ${POP_TIFF_PATH}`);
            return;
        }

        const proj4 = (await import('proj4')).default;
        proj4.defs('EPSG:54009', '+proj=moll +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs');

        const { default: Database } = await import('better-sqlite3');
        const { parseGpkgGeometry } = await import('../gpkg-reader.js');
        const { feature, bbox } = await import('@turf/turf');

        const DEFAULT_GPKG_PATHS = [
            process.env.GADM_GPKG_PATH,
            resolve(process.cwd(), 'data/gadm_410.gpkg'),
            resolve(process.cwd(), 'cache/gadm/gadm_410.gpkg'),
            resolve(__dirname, '../../data/gadm/gadm_410.gpkg'),
            resolve(__dirname, '../../../../gadm_410.gpkg')
        ].filter(Boolean) as string[];

        const GADM_GPKG_PATH = DEFAULT_GPKG_PATHS.find(p => existsSync(p));
        if (!GADM_GPKG_PATH) throw new Error('GADM database not found');
        
        const db = new Database(GADM_GPKG_PATH, { readonly: true });
        
        const moiaRow = db.prepare(`
            SELECT NAME_1, NAME_2, NAME_3, NAME_4, geom 
            FROM gadm_410 
            WHERE NAME_0 = 'Spain' 
              AND (NAME_4 = 'Moià' OR NAME_4 = 'Moia' OR NAME_3 = 'Moià' OR NAME_3 = 'Moia')
            LIMIT 1
        `).get() as any;

        const geometry = parseGpkgGeometry(Buffer.from(moiaRow.geom));
        
        // 1. Get the Bounding Box of the municipality in WGS84
        const f = feature(geometry as any);
        const [minLon, minLat, maxLon, maxLat] = bbox(f);
        
        // 2. Project bounding box corners to Mollweide
        const [minX, minY] = proj4('EPSG:4326', 'EPSG:54009', [minLon, minLat]);
        const [maxX, maxY] = proj4('EPSG:4326', 'EPSG:54009', [maxLon, maxLat]);
        
        const mollMinX = Math.min(minX, maxX);
        const mollMaxX = Math.max(minX, maxX);
        const mollMinY = Math.min(minY, maxY);
        const mollMaxY = Math.max(minY, maxY);

        // 3. Query the TIFF
        const tiff = await geotiff.fromFile(POP_TIFF_PATH);
        const image = await tiff.getImage();
        
        const origin = image.getOrigin();
        const resolution = image.getResolution();
        
        // 4. Convert bounding box to Pixel Window
        let py1 = Math.floor((mollMinY - origin[1]) / resolution[1]);
        let py2 = Math.floor((mollMaxY - origin[1]) / resolution[1]);
        
        const minPy = Math.max(0, Math.min(py1, py2));
        const maxPy = Math.min(image.getHeight(), Math.max(py1, py2));
        
        const minPx = Math.max(0, Math.floor((mollMinX - origin[0]) / resolution[0]));
        const maxPx = Math.min(image.getWidth(), Math.ceil((mollMaxX - origin[0]) / resolution[0]));

        const widthPx = maxPx - minPx;
        const heightPx = maxPy - minPy;

        // 5. Read the Raster
        const rasterData = await image.readRasters({ window: [minPx, minPy, maxPx, maxPy] }) as unknown as any[];
        
        let exactPopulation = 0;

        if (rasterData[0]) {
            const values = rasterData[0] as number[];
            
            // 6. Calculate Center of Mass based on Population
            let weightedSumX = 0;
            let weightedSumY = 0;
            let maxVal = 0;
            
            for (let y = 0; y < heightPx; y++) {
                for (let x = 0; x < widthPx; x++) {
                    const idx = y * widthPx + x;
                    const pop = values[idx];
                    
                    // NoData in the population dataset is typically a specific negative value or 65535 or NaN.
                    // Let's assume positive floats represent population.
                    if (pop !== undefined && !isNaN(pop) && pop > 0 && pop !== 65535) {
                        exactPopulation += pop;
                        weightedSumX += (minPx + x) * pop;
                        weightedSumY += (minPy + y) * pop;
                        if (pop > maxVal) maxVal = pop;
                    }
                }
            }

            if (exactPopulation > 0) {
                const centerPx = weightedSumX / exactPopulation;
                const centerPy = weightedSumY / exactPopulation;

                // 7. Convert center pixel back to WGS84
                const centerX = origin[0] + (centerPx * resolution[0]);
                const centerY = origin[1] + (centerPy * resolution[1]);
                const [centerLon, centerLat] = proj4('EPSG:54009', 'EPSG:4326', [centerX, centerY]);

                console.log(`\n===========================================`);
                console.log(`Region: ${moiaRow.NAME_1} > ${moiaRow.NAME_2} > ${moiaRow.NAME_4}`);
                console.log(`Total Exact Population (2030 Estimate): ${Math.round(exactPopulation)}`);
                console.log(`Max people in a single 100x100m block: ${Math.round(maxVal)}`);
                console.log(`Populated Center Coords (WGS84): [lon ${centerLon.toFixed(4)}, lat ${centerLat.toFixed(4)}]`);
                console.log(`===========================================\n`);
                
                writeFileSync(resolve(__dirname, '../../tests/tree/test-ghs-pop-moia-populated-center.json'), JSON.stringify({
                    geometryCenter: [centerLon, centerLat],
                    population: Math.round(exactPopulation),
                    maxDensity: Math.round(maxVal),
                    region: moiaRow.NAME_4
                }, null, 2), 'utf-8');
            } else {
                console.log(`No population found inside the bounding box!`);
            }
        }
        
        db.close();
    });
});
