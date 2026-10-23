# GHS Enrichment — Testing & Validation Plan

## Problem Statement

GHS (Global Human Settlement) population and built-up center dots on the MapLibre map may be landing **outside their parent boundary polygons** or in unexpected positions. The root cause could be:

1. **Pixel-offset mismatch** between C++ and TS enrichment
2. **Coordinate projection artifacts** (Mollweide ↔ WGS84 round-trip)
3. **Geometry simplification** distorting the original polygon the PIP check ran against
4. **Cache serialization** losing coordinate precision

## Suspected Root Causes

### 1. Pixel Center vs Pixel Corner (C++ vs TS)

The C++ `ghs_enrich.cpp` uses **pixel center** positioning:

```cpp
// C++ — pixel center (+0.5 offset)
double pxX = ri.origin_x + (minPx + x + 0.5) * ri.res_x;   // ← +0.5
double pxY = ri.origin_y + (minPy + y + 0.5) * ri.res_y;
```

The TS `enrich-ghs.ts` uses **pixel corner** positioning:

```ts
// TS — pixel corner (no offset)
const pxX = origin[0] + ((minPx + x) * resolution[0]);       // ← no +0.5
const pxY = origin[1] + ((minPy + y) * resolution[1]);
```

At 100m resolution, this shifts every candidate point by ~50m (half a pixel). The **weighted center** can shift 50–200m depending on the distribution. This is cosmetically noticeable at high zoom but not a critical accuracy bug.

### 2. Weighted Center Inconsistency (C++ internal)

In C++, the weighted center formula:

```cpp
double centerMollX = ri.origin_x + centerPx * ri.res_x;  // no +0.5
```

…does **not** include the +0.5 offset, even though `weightedX` was accumulated using pixel indices without the offset. The candidate centers (top-N peaks) however **do** use the +0.5. This means the main `ghsPopCenter` is offset by ~50m relative to the sub-centers array (`ghsPopCenters`).

### 3. Simplified Geometry ≠ Original Geometry

The PIP (point-in-polygon) check runs against the **original** full-resolution WKB geometry in `ghs_enrich.cpp`, but the **rendered polygon** on the map is the simplified version. This means centers proved to be "inside" the original polygon can visibly fall **outside** the simplified boundary at high zoom levels.

---

## Proposed TypeScript-Based Test Suite

### Test 1: Center-in-Polygon Verification

**Goal**: For every feature in a cache file, verify that all reported GHS centers lie inside the feature's geometry.

```ts
// test/ghs-validate.ts
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { containsPoint } from '../src/gpkg-reader';

const CACHE_DIR = 'cache/gadm';

function validateCacheFile(path: string): string[] {
    const errors: string[] = [];
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    const features = data.features || [];

    for (const f of features) {
        const geom = f.geometry;
        const props = f.properties || {};
        const name = props.name || props.code || 'unknown';

        // Check main centers
        for (const key of ['ghsPopCenter', 'ghsBuiltCenter'] as const) {
            const center = props[key];
            if (center && Array.isArray(center) && center.length === 2) {
                if (!containsPoint(geom, [center[0], center[1]])) {
                    errors.push(`${name}: ${key} [${center}] is OUTSIDE polygon`);
                }
            }
        }

        // Check sub-centers
        for (const key of ['ghsPopCenters', 'ghsBuiltCenters'] as const) {
            const centers = props[key];
            if (Array.isArray(centers)) {
                for (const c of centers) {
                    if (!containsPoint(geom, [c[0], c[1]])) {
                        errors.push(`${name}: ${key} [${c[0]},${c[1]}] is OUTSIDE polygon`);
                    }
                }
            }
        }
    }
    return errors;
}

// Run against all boundary_*.json files
const files = readdirSync(CACHE_DIR).filter(f => f.startsWith('boundary_') && f.endsWith('.json'));
let totalErrors = 0;
for (const file of files) {
    const errs = validateCacheFile(join(CACHE_DIR, file));
    if (errs.length > 0) {
        console.error(`\n❌ ${file} (${errs.length} failures):`);
        errs.forEach(e => console.error(`  - ${e}`));
        totalErrors += errs.length;
    }
}

console.log(`\n✅ Scanned ${files.length} files, ${totalErrors} center-outside-polygon errors.`);
```

> **Important**: This test will surface _expected_ failures due to simplification (Cause #3). The fix is to run PIP against the simplified geometry, not the original.

### Test 2: C++ vs TS Cross-Validation

**Goal**: Run TS enrichment on the same feature and compare centers with what the C++ pipeline produced.

```ts
// test/ghs-cross-validate.ts
import { enrichFeatureWithGHS } from '../src/enrich-ghs';
import { readFileSync } from 'fs';

const THRESHOLD_METERS = 200; // Max acceptable drift

function haversineMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
    const R = 6_371_000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function crossValidate(cacheFile: string) {
    const data = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    
    for (const f of data.features) {
        const cppPopCenter = f.properties?.ghsPopCenter;
        const cppBuiltCenter = f.properties?.ghsBuiltCenter;

        // Re-enrich using TS pipeline
        const tsResult = await enrichFeatureWithGHS(
            { type: 'Feature', properties: {}, geometry: f.geometry },
            { pop: true, built: true }
        );

        if (cppPopCenter && tsResult.ghsPopCenter) {
            const dist = haversineMeters(
                cppPopCenter[0], cppPopCenter[1],
                tsResult.ghsPopCenter[0], tsResult.ghsPopCenter[1]
            );
            if (dist > THRESHOLD_METERS) {
                console.warn(
                    `⚠️  Pop center drift: ${f.properties.name || f.properties.code} ` +
                    `= ${Math.round(dist)}m (cpp: ${cppPopCenter}, ts: ${tsResult.ghsPopCenter})`
                );
            }
        }

        if (cppBuiltCenter && tsResult.ghsBuiltCenter) {
            const dist = haversineMeters(
                cppBuiltCenter[0], cppBuiltCenter[1],
                tsResult.ghsBuiltCenter[0], tsResult.ghsBuiltCenter[1]
            );
            if (dist > THRESHOLD_METERS) {
                console.warn(
                    `⚠️  Built center drift: ${f.properties.name || f.properties.code} ` +
                    `= ${Math.round(dist)}m`
                );
            }
        }
    }
}
```

### Test 3: Precision Audit

**Goal**: Ensure no coordinate exceeds 5 decimal places in any cache file.

```ts
function auditPrecision(value: any, path: string, errors: string[]) {
    if (typeof value === 'number') {
        const str = value.toString();
        const decimalPart = str.includes('.') ? str.split('.')[1] : '';
        if (decimalPart.length > 5) {
            errors.push(`${path} = ${value} has ${decimalPart.length} decimals`);
        }
    } else if (Array.isArray(value)) {
        value.forEach((v, i) => auditPrecision(v, `${path}[${i}]`, errors));
    }
}
```

---

## Recommended Fix Priorities

| Priority | Fix | Effort | Impact |
|----------|-----|--------|--------|
| **P0** | Add +0.5 pixel offset to TS `enrich-ghs.ts` (match C++) | 1 line | Removes 50m systematic shift |
| **P1** | Fix C++ weighted center to use +0.5 offset consistently | 1 line | Aligns main center with sub-centers |
| **P2** | Document that simplified geometries may exclude original centers | Docs only | Sets correct expectation |
| **P3** | Option: re-run PIP on simplified geometry for display-only centers | Medium | Full visual correctness |

## Quick Fix (P0 + P1)

```diff
# enrich-ghs.ts (TS — match C++ pixel center)
- const pxX = origin[0] + ((minPx + x) * resolution[0]);
- const pxY = origin[1] + ((minPy + y) * resolution[1]);
+ const pxX = origin[0] + ((minPx + x + 0.5) * resolution[0]);
+ const pxY = origin[1] + ((minPy + y + 0.5) * resolution[1]);

# ghs_enrich.cpp (C++ — align weighted center)
- double centerMollX = ri.origin_x + centerPx * ri.res_x;
- double centerMollY = ri.origin_y + centerPy * ri.res_y;
+ double centerMollX = ri.origin_x + (centerPx + 0.5) * ri.res_x;
+ double centerMollY = ri.origin_y + (centerPy + 0.5) * ri.res_y;
```
