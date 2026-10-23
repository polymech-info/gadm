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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZW5yaWNoLXRhcnJhZ29uYS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9lbnJpY2gtdGFycmFnb25hLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxZQUFZLEVBQUUsYUFBYSxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBQ2pELE9BQU8sRUFBRSxJQUFJLEVBQUUsTUFBTSxNQUFNLENBQUM7QUFDNUIsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFFdkQsS0FBSyxVQUFVLElBQUk7SUFDZixPQUFPLENBQUMsR0FBRyxDQUFDLDJCQUEyQixDQUFDLENBQUM7SUFDekMsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLEVBQUUsRUFBRSxLQUFLLEVBQUUsV0FBVyxFQUFFLGdCQUFnQixDQUFDLENBQUM7SUFDM0UsTUFBTSxPQUFPLEdBQUcsWUFBWSxDQUFDLFFBQVEsRUFBRSxNQUFNLENBQUMsQ0FBQztJQUMvQyxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBRXBDLE9BQU8sQ0FBQyxHQUFHLENBQUMsU0FBUyxPQUFPLENBQUMsUUFBUSxDQUFDLE1BQU0saURBQWlELENBQUMsQ0FBQztJQUUvRixLQUFLLE1BQU0sT0FBTyxJQUFJLE9BQU8sQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUNyQyxPQUFPLENBQUMsR0FBRyxDQUFDLGFBQWEsT0FBTyxDQUFDLFVBQVUsQ0FBQyxNQUFNLEtBQUssQ0FBQyxDQUFDO1FBQ3pELE1BQU0sTUFBTSxHQUFHLE1BQU0sb0JBQW9CLENBQUMsT0FBTyxFQUFFLEVBQUUsR0FBRyxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztRQUUvRSwwREFBMEQ7UUFDMUQsTUFBTSxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsVUFBVSxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQzlDLENBQUM7SUFFRCxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxFQUFFLEtBQUssRUFBRSxXQUFXLEVBQUUseUJBQXlCLENBQUMsQ0FBQztJQUNuRixhQUFhLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3pELE9BQU8sQ0FBQyxHQUFHLENBQUMsNENBQTRDLE9BQU8sRUFBRSxDQUFDLENBQUM7QUFDdkUsQ0FBQztBQUVELElBQUksRUFBRSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMifQ==