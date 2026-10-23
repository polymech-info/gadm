import { readdirSync, renameSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const cacheDir = join(__dirname, '../cache/gadm');

if (!existsSync(cacheDir)) {
    console.error(`Cache directory not found: ${cacheDir}`);
    process.exit(1);
}

console.log(`Starting migration. Reading directory: ${cacheDir}... \n(This may take a moment for thousands of files)`);
console.time('readdir');
const files = readdirSync(cacheDir);
console.timeEnd('readdir');
console.log(`Found ${files.length} total entries.`);

let moved = 0;
let skipped = 0;
let processed = 0;

console.time('migration');
for (const file of files) {
    processed++;
    if (processed % 1000 === 0) {
        console.log(`Processed ${processed}/${files.length} files. Moved: ${moved}`);
    }

    if (!file.startsWith('boundary_') || !file.endsWith('.json')) {
        continue;
    }

    const fullPath = join(cacheDir, file);
    if (!statSync(fullPath).isFile()) {
        continue;
    }

    // Extract country code, e.g. "boundary_DEU.14_1_3.json" -> "DEU"
    const remainder = file.substring('boundary_'.length);
    const countryCode = remainder.split(/[._]/)[0];
    
    if (!countryCode) {
        console.warn(`Could not extract country code from ${file}, skipping.`);
        skipped++;
        continue;
    }

    const targetDir = join(cacheDir, countryCode);

    if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
    }

    const targetPath = join(targetDir, file);
    try {
        renameSync(fullPath, targetPath);
        moved++;
    } catch (e) {
        console.error(`Failed to move ${file}:`, e);
    }
}

console.log(`Migration complete. Moved: ${moved}, Skipped (invalid format): ${skipped}`);
