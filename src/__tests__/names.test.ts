import { describe, it, expect } from 'vitest';
import { getNames } from '../names.js';

describe('getNames', () => {
    it('finds France by name', async () => {
        const result = await getNames({ name: 'France' });
        expect(result.rows.length).toBe(1);
        expect(result.level).toBe(0);
        expect(result.rows[0].GID_0).toBe('FRA');
    });

    it('finds Germany by admin code', async () => {
        const result = await getNames({ admin: 'DEU' });
        expect(result.rows.length).toBe(1);
        expect(result.level).toBe(0);
        expect(result.rows[0].NAME_0).toBe('Germany');
    });

    it('returns sub-regions when contentLevel is specified', async () => {
        const result = await getNames({ admin: 'ESP', contentLevel: 1 });
        expect(result.level).toBe(1);
        expect(result.rows.length).toBeGreaterThan(10); // Spain has ~18 communities
        console.log(`Spain level-1: ${result.rows.length} regions`);
    });

    it('contentLevel clamps down to area level', async () => {
        // ESP is level 0, requesting contentLevel 0 should work fine
        const result = await getNames({ admin: 'ESP', contentLevel: 0 });
        expect(result.level).toBe(0);
        expect(result.rows.length).toBe(1);
    });

    it('throws on unknown name with suggestions', async () => {
        await expect(getNames({ name: 'Frence' }))
            .rejects
            .toThrow(/not part of GADM/);
    });

    it('throws when both name and admin are set', async () => {
        await expect(getNames({ name: 'France', admin: 'FRA' }))
            .rejects
            .toThrow(/"name" and "admin"/);
    });

    it('returns complete columns when complete=true', async () => {
        const result = await getNames({ admin: 'ESP', contentLevel: 1, complete: true });
        expect(result.rows[0]).toHaveProperty('NAME_0');
        expect(result.rows[0]).toHaveProperty('GID_0');
        expect(result.rows[0]).toHaveProperty('NAME_1');
        expect(result.rows[0]).toHaveProperty('GID_1');
    });

    it('returns world-level countries when no args given (contentLevel=0)', async () => {
        const result = await getNames({ contentLevel: 0 });
        expect(result.rows.length).toBeGreaterThan(200); // ~250 countries
        console.log(`World countries: ${result.rows.length}`);
    });
});
