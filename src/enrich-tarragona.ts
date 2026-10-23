import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { enrichFeatureWithGHS } from './enrich-ghs.js';

async function main() {
    console.log('Reading tarragona.json...');
    const dataPath = join(process.cwd(), 'src', '__tests__', 'tarragona.json');
    const rawData = readFileSync(dataPath, 'utf8');
    const geojson = JSON.parse(rawData);

    console.log(`Found ${geojson.features.length} features. Enriching with population centers...`);

    for (const feature of geojson.features) {
        console.log(`Enriching ${feature.properties.NAME_4}...`);
        const result = await enrichFeatureWithGHS(feature, { pop: true, built: true });
        
        // Merge the new hyper-accurate fields into the properties
        Object.assign(feature.properties, result);
    }

    const outPath = join(process.cwd(), 'src', '__tests__', 'tarragona_enriched.json');
    writeFileSync(outPath, JSON.stringify(geojson, null, 2));
    console.log(`\nSuccessfully wrote enriched output to: ${outPath}`);
}

main().catch(console.error);
