/**
 * Reprocess cached L0/L1 boundary JSON for map paint:
 * strip lake holes, drop outer islands <5 km min width, smooth coastline
 * V-spikes / harbour ears. Overwrites files in place (display-oriented cache).
 *
 *   npx tsx scripts/smooth-coast-cache.ts
 *   npx tsx scripts/smooth-coast-cache.ts --levels=0,1 --dry-run
 *   npx tsx scripts/smooth-coast-cache.ts --country=ESP
 *   npx tsx scripts/smooth-coast-cache.ts --min-outer-km=5
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { prepareBoundaryForMap } from '../src/simplify-map.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = join(__dirname, '../cache/gadm');

function parseArgs(argv: string[]) {
    let levels = new Set([0, 1]);
    let country: string | null = null;
    let dryRun = false;
    let keepHoles = false;
    let minOuterWidthKm = 5;
    for (const a of argv) {
        if (a === '--dry-run') dryRun = true;
        else if (a === '--keep-holes') keepHoles = true;
        else if (a.startsWith('--min-outer-km=')) {
            minOuterWidthKm = parseFloat(a.slice('--min-outer-km='.length));
            if (!Number.isFinite(minOuterWidthKm) || minOuterWidthKm < 0) minOuterWidthKm = 5;
        } else if (a.startsWith('--levels=')) {
            levels = new Set(
                a
                    .slice('--levels='.length)
                    .split(',')
                    .map((s) => parseInt(s.trim(), 10))
                    .filter((n) => n >= 0 && n <= 5),
            );
        } else if (a.startsWith('--country=')) {
            country = a.slice('--country='.length).toUpperCase();
        }
    }
    return { levels, country, dryRun, keepHoles, minOuterWidthKm };
}

/** Match boundary_{id}_{level}.json where level is a single digit we care about. */
function matchLevel(file: string, levels: Set<number>): number | null {
    const m = file.match(/^boundary_.+_([0-5])\.json$/);
    if (!m) return null;
    const level = parseInt(m[1], 10);
    return levels.has(level) ? level : null;
}

function countVerts(fc: GeoJSON.FeatureCollection): number {
    let n = 0;
    const walk = (c: any) => {
        if (typeof c?.[0] === 'number') n += 1;
        else if (Array.isArray(c)) for (const x of c) walk(x);
    };
    for (const f of fc.features || []) walk(f.geometry?.coordinates);
    return n;
}

function processFile(
    path: string,
    keepHoles: boolean,
    minOuterWidthKm: number,
    dryRun: boolean,
) {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as GeoJSON.FeatureCollection;
    if (!raw?.features?.length) return null;
    const beforeV = countVerts(raw);
    const beforeB = Buffer.byteLength(JSON.stringify(raw));
    const next = prepareBoundaryForMap(raw, { keepHoles, minOuterWidthKm });
    const afterV = countVerts(next);
    const afterB = Buffer.byteLength(JSON.stringify(next));
    if (!dryRun) {
        writeFileSync(path, JSON.stringify(next));
    }
    return { beforeV, afterV, beforeB, afterB };
}

function main() {
    const { levels, country, dryRun, keepHoles, minOuterWidthKm } = parseArgs(process.argv.slice(2));
    if (!existsSync(CACHE_ROOT)) {
        console.error('Cache root missing:', CACHE_ROOT);
        process.exit(1);
    }

    const countries = readdirSync(CACHE_ROOT).filter((name) => {
        const p = join(CACHE_ROOT, name);
        return statSync(p).isDirectory() && (!country || name.toUpperCase() === country);
    });

    let files = 0;
    let vertsBefore = 0;
    let vertsAfter = 0;
    let bytesBefore = 0;
    let bytesAfter = 0;

    console.log(
        `smooth-coast-cache levels=[${[...levels].join(',')}] keepHoles=${keepHoles} minOuterKm=${minOuterWidthKm} dryRun=${dryRun} countries=${countries.length}`,
    );

    for (const cc of countries) {
        const dir = join(CACHE_ROOT, cc);
        const list = readdirSync(dir).filter((f) => matchLevel(f, levels) != null);
        for (const f of list) {
            const path = join(dir, f);
            try {
                const r = processFile(path, keepHoles, minOuterWidthKm, dryRun);
                if (!r) continue;
                files++;
                vertsBefore += r.beforeV;
                vertsAfter += r.afterV;
                bytesBefore += r.beforeB;
                bytesAfter += r.afterB;
                const pct = r.beforeV ? (((r.beforeV - r.afterV) / r.beforeV) * 100).toFixed(1) : '0';
                console.log(
                    `${cc}/${f}: verts ${r.beforeV}→${r.afterV} (−${pct}%)  ${(r.beforeB / 1024).toFixed(0)}→${(r.afterB / 1024).toFixed(0)} KB`,
                );
            } catch (e: any) {
                console.error(`FAIL ${cc}/${f}:`, e.message);
            }
        }
    }

    console.log(
        `done files=${files} verts ${vertsBefore}→${vertsAfter} (${vertsBefore ? (((vertsBefore - vertsAfter) / vertsBefore) * 100).toFixed(1) : 0}% fewer)  ${(bytesBefore / 1048576).toFixed(1)}→${(bytesAfter / 1048576).toFixed(1)} MB`,
    );
}

main();
