import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import * as path from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { parseGpkgGeometry } from '../gpkg-reader.js';
const FUA_GPKG_PATH = path.join(process.cwd(), 'data/ghs/GHS_FUA_UCDB2015_GLOBE_R2019A_54009_1K_V1_0.gpkg');
const OUT_DIR = resolve('tests', 'tree');
function save(name, data) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, name), JSON.stringify(data, null, 2), 'utf-8');
    console.log(`  → saved tests/tree/${name}`);
}
describe('FUA GeoPackage', () => {
    it('reads and parses some populated built areas', () => {
        const db = new Database(FUA_GPKG_PATH, { readonly: true });
        // Find the table name
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'gpkg_%' AND name NOT LIKE 'rtree_%' AND name NOT LIKE 'sqlite_%'").all();
        expect(tables.length).toBeGreaterThan(0);
        const tableName = tables[0].name;
        console.log('Found table name:', tableName);
        // Find some rows, order by FUA_p_2015 descending to get the most populated areas
        const rows = db.prepare(`SELECT * FROM "${tableName}" ORDER BY FUA_p_2015 DESC LIMIT 5`).all();
        expect(rows.length).toBeGreaterThan(0);
        const resultsToSave = [];
        for (const row of rows) {
            console.log(`FUA ID: ${row.eFUA_ID}, Name: ${row.eFUA_name}, Pop 2015: ${row.FUA_p_2015}, Cntry: ${row.Cntry_name}`);
            let geometryData = null;
            if (row.geom) {
                const geometry = parseGpkgGeometry(Buffer.from(row.geom));
                expect(geometry.type).toBe('MultiPolygon');
                geometryData = {
                    type: geometry.type,
                    polygonCount: geometry.coordinates.length,
                    firstCoord: geometry.coordinates[0]?.[0]?.[0]
                };
            }
            resultsToSave.push({
                eFUA_ID: row.eFUA_ID,
                name: row.eFUA_name,
                pop2015: row.FUA_p_2015,
                country: row.Cntry_name,
                geometryInfo: geometryData,
                properties: {
                    UC_num: row.UC_num,
                    FUA_area: row.FUA_area
                }
            });
        }
        save('test-fua-top5.json', resultsToSave);
        db.close();
    });
    it('finds specific FUA data for Spain / Barcelona / Moia / Sentmenat', () => {
        const db = new Database(FUA_GPKG_PATH, { readonly: true });
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'gpkg_%' AND name NOT LIKE 'rtree_%' AND name NOT LIKE 'sqlite_%'").all();
        const tableName = tables[0].name;
        // Search for Barcelona, Moia, or Sentmenat generally in Spain
        const rows = db.prepare(`SELECT * FROM "${tableName}" 
             WHERE Cntry_name LIKE '%Spain%' 
             AND (eFUA_name LIKE '%Barcelona%' OR eFUA_name LIKE '%Moia%' OR eFUA_name LIKE '%Sentmenat%')`).all();
        const resultsToSave = [];
        console.log(`\n--- Spain / Barcelona / Moia / Sentmenat Search ---`);
        for (const row of rows) {
            console.log(`Found FUA: ID: ${row.eFUA_ID}, Name: ${row.eFUA_name}, Pop: ${Math.round(row.FUA_p_2015)}, Area: ${row.FUA_area}`);
            let geometryData = null;
            if (row.geom) {
                const geometry = parseGpkgGeometry(Buffer.from(row.geom));
                geometryData = {
                    type: geometry.type,
                    polygonCount: geometry.coordinates.length,
                    firstCoord: geometry.coordinates[0]?.[0]?.[0]
                };
            }
            resultsToSave.push({
                eFUA_ID: row.eFUA_ID,
                name: row.eFUA_name,
                pop2015: row.FUA_p_2015,
                country: row.Cntry_name,
                geometryInfo: geometryData,
                properties: {
                    UC_num: row.UC_num,
                    FUA_area: row.FUA_area
                }
            });
        }
        // If Moia or Sentmenat isn't found under FUA name, let's also query if there's any FUA named like them globally
        const globalRows = db.prepare(`SELECT * FROM "${tableName}" WHERE eFUA_name LIKE '%Moia%' OR eFUA_name LIKE '%Sentmenat%'`).all();
        if (globalRows.length > 0) {
            console.log(`Found ${globalRows.length} rows globally with name like 'Moia' or 'Sentmenat'`);
            for (const row of globalRows) {
                console.log(`  - ID: ${row.eFUA_ID}, Name: ${row.eFUA_name}, Country: ${row.Cntry_name}`);
            }
        }
        else {
            console.log('No FUA named Moia or Sentmenat found globally.');
        }
        save('test-fua-barcelona.json', resultsToSave);
        db.close();
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZnVhLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvX190ZXN0c19fL2Z1YS50ZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxRQUFRLEVBQUUsRUFBRSxFQUFFLE1BQU0sRUFBRSxNQUFNLFFBQVEsQ0FBQztBQUM5QyxPQUFPLFFBQVEsTUFBTSxnQkFBZ0IsQ0FBQztBQUN0QyxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sTUFBTSxDQUFDO0FBQy9CLE9BQU8sS0FBSyxJQUFJLE1BQU0sTUFBTSxDQUFDO0FBQzdCLE9BQU8sRUFBRSxhQUFhLEVBQUUsU0FBUyxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBQzlDLE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBRXRELE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxFQUFFLDJEQUEyRCxDQUFDLENBQUM7QUFDNUcsTUFBTSxPQUFPLEdBQUcsT0FBTyxDQUFDLE9BQU8sRUFBRSxNQUFNLENBQUMsQ0FBQztBQUV6QyxTQUFTLElBQUksQ0FBQyxJQUFZLEVBQUUsSUFBYTtJQUNyQyxTQUFTLENBQUMsT0FBTyxFQUFFLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7SUFDeEMsYUFBYSxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsSUFBSSxDQUFDLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQzlFLE9BQU8sQ0FBQyxHQUFHLENBQUMsd0JBQXdCLElBQUksRUFBRSxDQUFDLENBQUM7QUFDaEQsQ0FBQztBQUVELFFBQVEsQ0FBQyxnQkFBZ0IsRUFBRSxHQUFHLEVBQUU7SUFFNUIsRUFBRSxDQUFDLDZDQUE2QyxFQUFFLEdBQUcsRUFBRTtRQUNuRCxNQUFNLEVBQUUsR0FB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