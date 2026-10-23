import { describe, expect, it } from 'vitest';
import {
    dropSmallOuterIslands,
    prepareBoundaryForMap,
    stripInteriorRings,
} from '../simplify-map.js';

describe('simplify-map display clean', () => {
    it('strips interior rings', () => {
        const geom = {
            type: 'Polygon' as const,
            coordinates: [
                [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]],
                [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]],
            ],
        };
        const out = stripInteriorRings(geom);
        expect(out?.type).toBe('Polygon');
        expect((out as GeoJSON.Polygon).coordinates).toHaveLength(1);
    });

    it('drops outer islands under 5 km min width, keeps mainland', () => {
        const geom = {
            type: 'MultiPolygon' as const,
            coordinates: [
                [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
                [[[2, 0], [2.01, 0], [2.01, 0.01], [2, 0.01], [2, 0]]],
            ],
        };
        const out = dropSmallOuterIslands(geom, 5);
        expect(out?.type).toBe('Polygon');
    });

    it('prepareBoundaryForMap stamps _mapPaint', () => {
        const fc = prepareBoundaryForMap({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'Polygon',
                    coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
                },
            }],
        });
        expect((fc as any)._mapPaint).toBe(true);
        expect(fc.features).toHaveLength(1);
    });
});
