import * as geotiff from 'geotiff';
import proj4 from 'proj4';
import { bbox as turfBbox, booleanPointInPolygon, point as turfPoint } from '@turf/turf';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

// Check if we need to define EPSG:54009
try {
    proj4('EPSG:54009');
} catch (e) {
    proj4.defs('EPSG:54009', '+proj=moll +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs');
}

export interface GHSEnrichOptions {
    pop?: boolean | string;
    built?: boolean | string;
    // Legacy properties
    popTiffPath?: string;
    builtTiffPath?: string;
}

const DEFAULT_POP_PATHS = [
    process.env.GHS_POP_PATH,
    resolve(process.cwd(), 'cache/ghs/GHS_POP_E2030_GLOBE_R2023A_54009_100_V1_0.tif'),
    resolve(process.cwd(), 'data/ghs/GHS_POP_E2030_GLOBE_R2023A_54009_100_V1_0.tif'),
    resolve(_dirname, '../cache/ghs/GHS_POP_E2030_GLOBE_R2023A_54009_100_V1_0.tif'),
    resolve(_dirname, '../data/ghs/GHS_POP_E2030_GLOBE_R2023A_54009_100_V1_0.tif'),
    resolve(_dirname, '../../data/ghs/GHS_POP_E2030_GLOBE_R2023A_54009_100_V1_0.tif')
].filter(Boolean) as string[];

const DEFAULT_BUILT_PATHS = [
    process.env.GHS_BUILT_PATH,
    resolve(process.cwd(), 'cache/ghs/GHS_BUILT_S_E2030_GLOBE_R2023A_54009_100_V1_0.tif'),
    resolve(_dirname, '../data/ghs/GHS_BUILT_S_E2030_GLOBE_R2023A_54009_100_V1_0.tif'),
].filter(Boolean) as string[];

function resolveTiffPath(overrideStr?: string, overrideBool?: boolean | string, defaults: string[] = []): string | null {
    if (typeof overrideStr === 'string' && existsSync(overrideStr)) return overrideStr;
    if (typeof overrideBool === 'string' && existsSync(overrideBool)) return overrideBool;
    if (overrideBool === false) return null;

    // Auto-resolve
    for (const p of defaults) {
        if (existsSync(p)) return p;
    }
    return null;
}

export interface GHSEnrichResult {
    ghsPopulation?: number;
    ghsPopMaxDensity?: number;
    ghsPopCenter?: [number, number]; // [lon, lat]
    ghsPopCenters?: [number, number, number][]; // Array of local maxima [lon, lat, pop_density]

    ghsBuiltWeight?: number;
    ghsBuiltMax?: number;
    ghsBuiltCenter?: [number, number]; // [lon, lat]
    ghsBuiltCenters?: [number, number, number][]; // Array of local maxima [lon, lat, built_density]
}

const geoTiffCache = new Map<string, { tiff: any; image: any; origin: number[]; resolution: number[] }>();

export async function enrichFeatureWithGHS(
    feature: any,
    options: GHSEnrichOptions
): Promise<GHSEnrichResult> {
    const result: GHSEnrichResult = {};

    const [minLon, minLat, maxLon, maxLat] = turfBbox(feature);

    // Project bounding box corners to Mollweide
    const [minX, minY] = proj4('EPSG:4326', 'EPSG:54009', [minLon, minLat]);
    const [maxX, maxY] = proj4('EPSG:4326', 'EPSG:54009', [maxLon, maxLat]);

    const mollMinX = Math.min(minX, maxX);
    const mollMaxX = Math.max(minX, maxX);
    const mollMinY = Math.min(minY, maxY);
    const mollMaxY = Math.max(minY, maxY);

    async function computeStats(tiffPath: string, isPop: boolean) {
        if (!tiffPath || !existsSync(tiffPath)) return null;

        let entry = geoTiffCache.get(tiffPath);
        if (!entry) {
            const tiff = await geotiff.fromFile(tiffPath);
            const image = await tiff.getImage();
            entry = {
                tiff,
                image,
                origin: image.getOrigin(),
                resolution: image.getResolution()
            };
            geoTiffCache.set(tiffPath, entry);
        }

        const { image, origin, resolution } = entry;

        let py1 = Math.floor((mollMinY - origin[1]) / resolution[1]);
        let py2 = Math.floor((mollMaxY - origin[1]) / resolution[1]);

        const minPy = Math.max(0, Math.min(py1, py2));
        const maxPy = Math.min(image.getHeight(), Math.max(py1, py2));
        const minPx = Math.max(0, Math.floor((mollMinX - origin[0]) / resolution[0]));
        const maxPx = Math.min(image.getWidth(), Math.ceil((mollMaxX - origin[0]) / resolution[0]));

        const widthPx = maxPx - minPx;
        const heightPx = maxPy - minPy;

        if (widthPx <= 0 || heightPx <= 0) return null;

        const rasterData = await image.readRasters({ window: [minPx, minPy, maxPx, maxPy] }) as unknown as any[];

        if (!rasterData[0]) return null;

        const values = rasterData[0] as number[];

        let totalVal = 0;
        let weightedSumX = 0;
        let weightedSumY = 0;
        let maxVal = 0;

        const candidateLon: number[] = [];
        const candidateLat: number[] = [];
        const candidateX: number[] = [];
        const candidateY: number[] = [];
        const candidateVal: number[] = [];

        for (let y = 0; y < heightPx; y++) {
            for (let x = 0; x < widthPx; x++) {
                const idx = y * widthPx + x;
                const val = values[idx];

                // For GHSL tiffs, NoData is usually 65535 or negative
                if (val !== undefined && !isNaN(val) && val > 0 && val !== 65535) {
                    // Project pixel center to LonLat to verify it's inside the actual polygon
                    const pxX = origin[0] + ((minPx + x + 0.5) * resolution[0]);
                    const pxY = origin[1] + ((minPy + y + 0.5) * resolution[1]);
                    const [ptLon, ptLat] = proj4('EPSG:54009', 'EPSG:4326', [pxX, pxY]);

                    if (booleanPointInPolygon(turfPoint([ptLon, ptLat]), feature)) {
                        totalVal += val;
                        weightedSumX += (minPx + x) * val;
                        weightedSumY += (minPy + y) * val;
                        if (val > maxVal) maxVal = val;

                        candidateLon.push(ptLon);
                        candidateLat.push(ptLat);
                        candidateX.push(pxX);
                        candidateY.push(pxY);
                        candidateVal.push(val);
                    }
                }
            }
        }

        if (totalVal > 0) {
            const centerPx = weightedSumX / totalVal;
            const centerPy = weightedSumY / totalVal;
            const centerX = origin[0] + (centerPx * resolution[0]);
            const centerY = origin[1] + (centerPy * resolution[1]);
            const [centerLon, centerLat] = proj4('EPSG:54009', 'EPSG:4326', [centerX, centerY]);

            const indices = new Int32Array(candidateVal.length);
            for (let i = 0; i < indices.length; i++) indices[i] = i;
            indices.sort((a, b) => candidateVal[b] - candidateVal[a]);

            const centers: [number, number, number][] = [];
            const selectedIndices: number[] = [];
            const MIN_DIST_METERS = 3000; // Require 3km separation between peaks
            const MAX_CENTERS = 5;

            for (let i = 0; i < indices.length && centers.length < MAX_CENTERS; i++) {
                const idx = indices[i];
                const x = candidateX[idx];
                const y = candidateY[idx];

                let isDistinct = true;
                for (const exIdx of selectedIndices) {
                    const exX = candidateX[exIdx];
                    const exY = candidateY[exIdx];
                    if (Math.hypot(x - exX, y - exY) < MIN_DIST_METERS) {
                        isDistinct = false;
                        break;
                    }
                }
                if (isDistinct) {
                    selectedIndices.push(idx);
                    const centerVal = isPop ? Math.round(candidateVal[idx]) : Number(candidateVal[idx].toFixed(1));
                    centers.push([Number(candidateLon[idx].toFixed(5)), Number(candidateLat[idx].toFixed(5)), centerVal]);
                }
            }

            return {
                total: isPop ? Math.round(totalVal) : Number(totalVal.toFixed(1)),
                max: isPop ? Math.round(maxVal) : Number(maxVal.toFixed(1)),
                center: [Number(centerLon.toFixed(5)), Number(centerLat.toFixed(5))] as [number, number],
                centers // Top 5 distinct local maxima
            };
        }

        return null;
    }
    const activePopPath = resolveTiffPath(options.popTiffPath, options.pop, DEFAULT_POP_PATHS);
    if (activePopPath) {
        const popStats = await computeStats(activePopPath, true);
        if (popStats) {
            result.ghsPopulation = popStats.total;
            result.ghsPopMaxDensity = popStats.max;
            result.ghsPopCenter = popStats.center;
            result.ghsPopCenters = popStats.centers;
        }
    }

    const activeBuiltPath = resolveTiffPath(options.builtTiffPath, options.built, DEFAULT_BUILT_PATHS);
    if (activeBuiltPath) {
        const builtStats = await computeStats(activeBuiltPath, false);
        if (builtStats) {
            result.ghsBuiltWeight = builtStats.total;
            result.ghsBuiltMax = builtStats.max;
            result.ghsBuiltCenter = builtStats.center;
            result.ghsBuiltCenters = builtStats.centers;
        }
    }

    return result;
}
