import { describe, it, expect } from 'vitest';
import { loadDatabase, getColumns } from '../database.js';

describe('GADM Database', () => {
    it('loads the parquet database with 400k+ rows', async () => {
        const rows = await loadDatabase();
        expect(rows.length).toBeGreaterThan(100_000);
        console.log(`Loaded ${rows.length} rows`);
    });

    it('has the expected 12 data columns', async () => {
        const cols = getColumns();
        expect(cols).toContain('NAME_0');
        expect(cols).toContain('GID_0');
        expect(cols).toContain('NAME_5');
        expect(cols).toContain('GID_5');
        expect(cols).toHaveLength(12);
    });

    it('can find France by NAME_0', async () => {
        const rows = await loadDatabase();
        const france = rows.filter(r => r.NAME_0?.toLowerCase() === 'france');
        expect(france.length).toBeGreaterThan(0);
        expect(france[0].GID_0).toBe('FRA');
        console.log(`France: ${france.length} rows, GID_0=${france[0].GID_0}`);
    });

    it('can find Germany by GID_0', async () => {
        const rows = await loadDatabase();
        const deu = rows.filter(r => r.GID_0 === 'DEU');
        expect(deu.length).toBeGreaterThan(0);
        expect(deu[0].NAME_0?.toLowerCase()).toBe('germany');
        console.log(`Germany: ${deu.length} rows`);
    });

    it('has sub-levels for Spain', async () => {
        const rows = await loadDatabase();
        const esp1 = rows.filter(r => r.GID_0 === 'ESP' && r.NAME_1 !== '');
        expect(esp1.length).toBeGreaterThan(10); // Spain has 19 communities
        console.log(`Spain level-1 regions: ${new Set(esp1.map(r => r.NAME_1)).size}`);
    });
});
