import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import * as path from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { parseGpkgGeometry } from '../gpkg-reader.js';

const FUA_GPKG_PATH = path.join(process.cwd(), 'data/ghs/GHS_FUA_UCDB2015_GLOBE_R2019A_54009_1K_V1_0.gpkg');
const OUT_DIR = resolve('tests', 'tree');

function save(name: string, data: unknown) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, name), JSON.stringify(data, null, 2), 'utf-8');
    console.log(`  → saved tests/tree/${name}`);
}

describe('FUA GeoPackage', () => {

    it('reads and parses some populated built areas', () => {
        const db = new Database(FUA_GPKG_PATH, { readonly: true });

        // Find the table name
        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'gpkg_%' AND name NOT LIKE 'rtree_%' AND name NOT LIKE 'sqlite_%'"
        ).all() as any[];

        expect(tables.length).toBeGreaterThan(0);
        const tableName = tables[0].name;
        console.log('Found table name:', tableName);

        // Find some rows, order by FUA_p_2015 descending to get the most populated areas
        const rows = db.prepare(`SELECT * FROM "${tableName}" ORDER BY FUA_p_2015 DESC LIMIT 5`).all() as any[];

        expect(rows.length).toBeGreaterThan(0);

        const resultsToSave: any[] = [];

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

        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'gpkg_%' AND name NOT LIKE 'rtree_%' AND name NOT LIKE 'sqlite_%'"
        ).all() as any[];

        const tableName = tables[0].name;

        // Search for Barcelona, Moia, or Sentmenat generally in Spain
        const rows = db.prepare(
            `SELECT * FROM "${tableName}" 
             WHERE Cntry_name LIKE '%Spain%' 
             AND (eFUA_name LIKE '%Barcelona%' OR eFUA_name LIKE '%Moia%' OR eFUA_name LIKE '%Sentmenat%')`
        ).all() as any[];

        const resultsToSave: any[] = [];

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
        const globalRows = db.prepare(`SELECT * FROM "${tableName}" WHERE eFUA_name LIKE '%Moia%' OR eFUA_name LIKE '%Sentmenat%'`).all() as any[];
        if (globalRows.length > 0) {
            console.log(`Found ${globalRows.length} rows globally with name like 'Moia' or 'Sentmenat'`);
            for (const row of globalRows) {
                console.log(`  - ID: ${row.eFUA_ID}, Name: ${row.eFUA_name}, Country: ${row.Cntry_name}`);
            }
        } else {
            console.log('No FUA named Moia or Sentmenat found globally.');
        }

        save('test-fua-barcelona.json', resultsToSave);
        db.close();
    });

});
