import { describe, it, expect } from 'vitest';
import * as geotiff from 'geotiff';
import { resolve } from 'path';
import * as path from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const TIFF_PATH = path.join(process.cwd(), 'data/ghs/GHS_BUILT_S_E2030_GLOBE_R2023A_54009_100_V1_0.tif');
const FUA_JSON_PATH = resolve(__dirname, '../../tests/tree/test-fua-barcelona.json');

describe('GHS Built-up GeoTIFF', () => {

    it('reads GeoTIFF metadata', async () => {
        const tiff = await geotiff.fromFile(TIFF_PATH);
        const image = await tiff.getImage();

        const width = image.getWidth();
        const height = image.getHeight();
        const tileWidth = image.getTileWidth();
        const tileHeight = image.getTileHeight();
        const samplesPerPixel = image.getSamplesPerPixel();
        const origin = image.getOrigin();
        const resolution = image.getResolution();
        const bbox = image.getBoundingBox();

        console.log(`\n--- GeoTIFF Metadata ---`);
        console.log(`Dimensions: ${width} x ${height}`);
        console.log(`Tile Size: ${tileWidth} x ${tileHeight}`);
        console.log(`Samples per pixel: ${samplesPerPixel}`);
        console.log(`Origin:`, origin);
        console.log(`Resolution:`, resolution);
        console.log(`Bounding Box:`, bbox);

        expect(width).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(0);
    });

    it('reads built-up data for a specific pixel (center of Barcelona)', async () => {
        // We will just read a tiny window in the center of the image if JSON isn't available,
        // or try to read the center of the FUA if available.
        let xCoord = 0;
        let yCoord = 0;

        if (existsSync(FUA_JSON_PATH)) {
            const data = JSON.parse(readFileSync(FUA_JSON_PATH, 'utf-8'));
            if (data.length > 0 && data[0].geometryInfo && data[0].geometryInfo.firstCoord) {
                // Coordinate from Mollweide FUA geometry array
                // The first coordinate of the first polygon ring
                xCoord = data[0].geometryInfo.firstCoord[0];
                yCoord = data[0].geometryInfo.firstCoord[1];
            }
        }

        console.log(`\n--- Querying TIFF at coordinate [${xCoord}, ${yCoord}] ---`);

        const tiff = await geotiff.fromFile(TIFF_PATH);
        const image = await tiff.getImage();

        const origin = image.getOrigin();
        const resolution = image.getResolution();

        // Convert map coordinates to pixel coordinates
        const px = Math.floor((xCoord - origin[0]) / resolution[0]);
        const py = Math.floor((yCoord - origin[1]) / resolution[1]);

        console.log(`Pixel coordinates: [${px}, ${py}]`);

        if (px >= 0 && px < image.getWidth() && py >= 0 && py < image.getHeight()) {
            // Read a 10x10 window around the pixel
            const window = [
                Math.max(0, px - 5),
                Math.max(0, py - 5),
                Math.min(image.getWidth(), px + 5),
                Math.min(image.getHeight(), py + 5)
            ];

            const rasterData = await image.readRasters({ window }) as unknown as any[];
            console.log(`Read a 10x10 window around the pixel. Raster data length: ${rasterData.length}`);

            // Log some values
            if (rasterData[0]) {
                const values = rasterData[0] as number[];
                const validValues = Array.from(values).filter((v: number) => v !== 65535); // assuming 65535 is nodata
                if (validValues.length > 0) {
                    const avg = validValues.reduce((a, b) => a + b, 0) / validValues.length;
                    const max = Math.max(...validValues);
                    console.log(`Values in 10x10 window -> Max: ${max}, Avg: ${avg.toFixed(2)}`);
                    writeFileSync(resolve(__dirname, '../../tests/tree/test-geotiff-barcelona.json'), JSON.stringify({ max, avg, count: validValues.length, allValues: Array.from(values) }, null, 2), 'utf-8');
                } else {
                    console.log(`All values in window are NoData (65535).`);
                }
            }
            expect(rasterData).toBeDefined();
        } else {
            console.log('Coordinate is out of bounds for this TIFF.');
        }
    });

    it('finds Moia populated center using GeoTIFF Center of Mass', async () => {
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

        // Because of projection curve, we should ensure the bounds cover everything.
        // We will just pad slightly min/max.
        const mollMinX = Math.min(minX, maxX);
        const mollMaxX = Math.max(minX, maxX);
        const mollMinY = Math.min(minY, maxY);
        const mollMaxY = Math.max(minY, maxY);

        // 3. Query the TIFF
        const tiff = await geotiff.fromFile(TIFF_PATH);
        const image = await tiff.getImage();

        const origin = image.getOrigin();
        const resolution = image.getResolution();

        // 4. Convert bounding box to Pixel Window
        // resolution[1] is typically negative for Y since Origin is top-left
        let py1 = Math.floor((mollMinY - origin[1]) / resolution[1]);
        let py2 = Math.floor((mollMaxY - origin[1]) / resolution[1]);

        const minPy = Math.max(0, Math.min(py1, py2));
        const maxPy = Math.min(image.getHeight(), Math.max(py1, py2));

        const minPx = Math.max(0, Math.floor((mollMinX - origin[0]) / resolution[0]));
        const maxPx = Math.min(image.getWidth(), Math.ceil((mollMaxX - origin[0]) / resolution[0]));

        console.log(`\nMoià pixel bounds: X[${minPx} - ${maxPx}], Y[${minPy} - ${maxPy}]`);
        const widthPx = maxPx - minPx;
        const heightPx = maxPy - minPy;
        console.log(`Window size: ${widthPx} x ${heightPx} pixels`);

        // 5. Read the Raster
        const rasterData = await image.readRasters({ window: [minPx, minPy, maxPx, maxPy] }) as unknown as any[];

        if (rasterData[0]) {
            const values = rasterData[0] as number[];

            // 6. Calculate Center of Mass
            let totalWeight = 0;
            let weightedSumX = 0;
            let weightedSumY = 0;
            let maxVal = 0;

            for (let y = 0; y < heightPx; y++) {
                for (let x = 0; x < widthPx; x++) {
                    const idx = y * widthPx + x;
                    const val = values[idx];

                    if (val !== 65535 && val > 0) { // Valid built-up data
                        totalWeight += val;
                        weightedSumX += (minPx + x) * val;
                        weightedSumY += (minPy + y) * val;
                        if (val > maxVal) maxVal = val;
                    }
                }
            }

            if (totalWeight > 0) {
                const centerPx = weightedSumX / totalWeight;
                const centerPy = weightedSumY / totalWeight;

                // 7. Convert center pixel back to Mollweide and then to WGS84
                const centerX = origin[0] + (centerPx * resolution[0]);
                const centerY = origin[1] + (centerPy * resolution[1]);

                const [centerLon, centerLat] = proj4('EPSG:54009', 'EPSG:4326', [centerX, centerY]);

                console.log(`\n===========================================`);
                console.log(`Region: ${moiaRow.NAME_1} > ${moiaRow.NAME_2} > ${moiaRow.NAME_4}`);
                console.log(`Center of Mass (Pixels): [${centerPx.toFixed(2)}, ${centerPy.toFixed(2)}]`);
                console.log(`Populated Center Coords (WGS84): [lon ${centerLon.toFixed(4)}, lat ${centerLat.toFixed(4)}]`);
                console.log(`Max pixel density found: ${maxVal}`);
                console.log(`===========================================\n`);

                writeFileSync(resolve(__dirname, '../../tests/tree/test-geotiff-moia-populated-center.json'), JSON.stringify({
                    geometryCenter: [centerLon, centerLat],
                    totalWeight,
                    maxVal,
                    region: moiaRow.NAME_4
                }, null, 2), 'utf-8');
            } else {
                console.log(`No built-up area found inside the bounding box!`);
            }
        }

        db.close();
    });

});
