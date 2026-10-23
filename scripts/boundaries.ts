import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { getBoundaryFromGpkg } from '../src/gpkg-reader.js';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function processCountry(country: string, level: number | undefined, resolution: number, force: boolean) {
    if (level !== undefined) {
        console.log(`Processing ${country} at level ${level}...`);
        await doProcess(country, level, resolution, force);
    } else {
        console.log(`Processing ${country} for all levels (0-5)...`);
        for (let l = 0; l <= 5; l++) {
            await doProcess(country, l, resolution, force);
        }
    }
}

async function doProcess(country: string, level: number | undefined, resolution: number, force: boolean) {
    const levelStr = level !== undefined ? level.toString() : 'auto';
    const safeCountry = country.replace(/[^a-zA-Z0-9\.\-_]/g, '_').substring(0, 50);
    const countryCode = safeCountry.split('.')[0];
    const expectedDir = join(__dirname, '../cache/gadm', countryCode);
    const expectedFile = join(expectedDir, `boundary_${safeCountry}_${levelStr}.json`);
    
    if (!force && existsSync(expectedFile)) {
        console.log(`⏭️  ${country} (L${level ?? 0}): Skipped, already cached.`);
        return;
    }

    try {
        const start = Date.now();
        const res = await getBoundaryFromGpkg(country, level, undefined, resolution);
        const duration = Date.now() - start;
        if (res && res.features && res.features.length > 0) {
            console.log(`✅ ${country} (L${level ?? 0}): Successfully cached in ${duration}ms (${res.features.length} features).`);
        } else {
            console.log(`❌ ${country} (L${level ?? 0}): No boundary found.`);
        }
    } catch (e: any) {
        console.error(`❌ ${country} (L${level ?? 0}): Failed - ${e.message}`);
    }
}

async function main() {
    const argv = await yargs(hideBin(process.argv))
        .option('country', {
            type: 'string',
            description: "ISO3 country code (e.g. DEU, ESP), or 'all' for batch",
            demandOption: true,
            alias: 'c'
        })
        .option('level', {
            type: 'number',
            description: 'Admin level (0-5). Omit for all levels.',
            alias: 'l'
        })
        .option('resolution', {
            type: 'number',
            description: 'Simplification resolution (1=full to 10=max simplification)',
            default: 3
        })
        .option('force', {
            type: 'boolean',
            description: 'Regenerate even if cache file exists',
            default: false
        })
        .option('split-levels', {
            type: 'string',
            description: 'Comma-separated levels to split output files (e.g. 1,2,3)',
        })
        .help()
        .argv;

    const country = argv.country as string;
    const level = argv.level as number | undefined;
    const resolution = argv.resolution as number;
    const force = argv.force as boolean;
    const splitLevelsStr = argv['split-levels'] as string | undefined;

    // Parse split-levels if provided (not yet implemented in TS — matches CLI parity)
    if (splitLevelsStr) {
        console.log(`⚠️  --split-levels=${splitLevelsStr} is accepted but not yet implemented in the TS pipeline.`);
        console.log(`   Use the C++ binary for split-level generation: boundaries.exe --country=${country} --split-levels=${splitLevelsStr}`);
    }

    const continentData = JSON.parse(
        readFileSync(join(__dirname, '../data/gadm_continent.json'), 'utf-8')
    );

    if (country.toLowerCase() === 'all') {
        const allCountries = new Set<string>();
        for (const codes of Object.values(continentData)) {
            for (const code of codes as string[]) {
                allCountries.add(code);
            }
        }
        
        console.log(`Starting precalculation for ${allCountries.size} countries at level ${level ?? 'all'}...`);
        console.log(`Resolution: ${resolution}, Force: ${force}`);
        let current = 1;
        for (const code of allCountries) {
            console.log(`\n[${current}/${allCountries.size}]`);
            await processCountry(code, level, resolution, force);
            current++;
        }
        console.log('\n🎉 Finished precalculating all countries.');
    } else {
        await processCountry(country.toUpperCase(), level, resolution, force);
    }
}

main().catch(console.error);
