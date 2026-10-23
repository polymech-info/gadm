/**
 * Items — GeoJSON boundary fetcher.
 *
 * Reads geometry from a local GeoPackage file when available,
 * falls back to the GADM CDN. Results include corrected names
 * from the parquet database.
 */
import { getNames } from './names.js';
import { getBoundaryFromGpkg, type GadmCache } from './gpkg-reader.js';
// import CONTINENT_MAP_JSON from '../data/gadm_continent.json' with { type: 'json' };

// ---------- types ----------

export interface ItemsOptions {
    /** Administrative area name(s). Cannot use with `admin`. */
    name?: string | string[];
    /** GADM admin code(s). Cannot use with `name`. */
    admin?: string | string[];
    /** Target content level (0-5). -1 = auto-detect. */
    contentLevel?: number;
    /** Optional external cache implementation to bypass file cache */
    cache?: GadmCache;
}

import type { GHSEnrichResult } from './enrich-ghs.js';

export type GeoJSONFeatureProperties = Record<string, string | number | boolean | any> & GHSEnrichResult;

export interface GeoJSONFeature {
    type: 'Feature';
    properties: GeoJSONFeatureProperties;
    geometry: any;
}

export interface GeoJSONCollection {
    type: 'FeatureCollection';
    features: GeoJSONFeature[];
}

// ---------- constants ----------

const GADM_URL = 'https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_{}_{}.json';

/** Continent → ISO3 codes mapping (inlined to avoid runtime file-system dependency) */
const CONTINENT_MAP: Record<string, string[]> = {
    africa: ["DZA", "AGO", "BEN", "BWA", "BFA", "BDI", "CPV", "CMR", "CAF", "ESH", "TCD", "COM", "COG", "COD", "DJI", "EGY", "GNQ", "ERI", "SWZ", "ETH", "GAB", "GMB", "GHA", "GIN", "GNB", "CIV", "KEN", "LSO", "LBR", "LBY", "MDG", "MWI", "MLI", "MRT", "MUS", "MYT", "MAR", "MOZ", "NAM", "NER", "NGA", "REU", "RWA", "STP", "SEN", "SYC", "SLE", "SOM", "ZAF", "SSD", "SDN", "TZA", "TGO", "TUN", "UGA", "ZMB", "ZWE"],
    asia: ["AFG", "ARM", "AZE", "BGD", "BTN", "IOT", "BHR", "BRN", "KHM", "CHN", "IND", "IDN", "IRN", "IRQ", "ISR", "JPN", "JOR", "KAZ", "KWT", "KGZ", "LAO", "LBN", "MYS", "MDV", "MNG", "MMR", "NPL", "PRK", "OMN", "PAK", "PSE", "PHL", "QAT", "RUS", "SAU", "SGP", "KOR", "LKA", "SYR", "THA", "TWN", "TJK", "TLS", "TKM", "ARE", "UZB", "VNM", "YEM", "SJM", "XCA", "XPI", "Z01", "Z02", "Z03", "Z04", "Z05", "Z06", "Z07", "Z08", "Z09"],
    europe: ["ALA", "ALB", "AND", "AUT", "BLR", "BEL", "BIH", "BGR", "HRV", "CYP", "CZE", "DNK", "EST", "FIN", "FRA", "FRO", "GEO", "GIB", "GGY", "DEU", "GRC", "HUN", "ISL", "IRL", "ITA", "LVA", "LIE", "LTU", "LUX", "MLT", "MDA", "MCO", "MNE", "NLD", "MKD", "NOR", "POL", "PRT", "ROU", "SMR", "SRB", "SVK", "SVN", "ESP", "SWE", "CHE", "TUR", "UKR", "GBR", "VAT", "IMN", "JEY", "XAD", "ZNC", "XKO"],
    "north america": ["ATG", "BHS", "BRB", "BLZ", "CAN", "CRI", "CUB", "DMA", "DOM", "SLV", "GRD", "GTM", "HTI", "HND", "JAM", "MEX", "NIC", "PAN", "KNA", "LCA", "VCT", "TTO", "USA", "AIA", "ABW", "BMU", "BES", "VGB", "CYM", "XCL", "CUW", "GRL", "GLP", "MTQ", "MSR", "UMI", "PRI", "BLM", "MAF", "SPM", "SXM", "TCA", "VIR"],
    "south america": ["ARG", "BOL", "BRA", "CHL", "COL", "ECU", "GUY", "PRY", "PER", "SUR", "URY", "VEN", "BVT", "FLK", "GUF", "SGS", "SHN"],
    oceania: ["AUS", "CCK", "CXR", "FJI", "KIR", "MHL", "FSM", "NRU", "NZL", "PLW", "PNG", "WSM", "SLB", "TON", "TUV", "VUT", "ASM", "COK", "PYF", "GUM", "NCL", "NIU", "NFK", "MNP", "PCN", "TKL", "WLF", "HMD", "XSP"],
    antartica: ["ATA", "ATF"],
};


// ---------- main function ----------

/**
 * Fetch GeoJSON boundaries for administrative areas.
 * Tries local GeoPackage first, falls back to GADM CDN.
 */
export async function getItems(opts: ItemsOptions): Promise<GeoJSONCollection> {
    let { name, admin, contentLevel = -1, cache } = opts;

    // Normalize to arrays
    let names = typeof name === 'string' ? [name] : (name || []);
    let admins = typeof admin === 'string' ? [admin] : (admin || []);

    if (names.length === 0 && admins.length === 0) {
        throw new Error('At least "name" or "admin" need to be set.');
    }

    // Continent expansion
    if (names.length === 1 && names[0].toLowerCase() in CONTINENT_MAP) {
        admins = CONTINENT_MAP[names[0].toLowerCase()];
        names = [];
    }

    // Fetch all items
    const allFeatures: GeoJSONFeature[] = [];

    for (const n of names) {
        const features = await fetchSingleItem(n, '', contentLevel, cache);
        allFeatures.push(...features);
    }
    for (const a of admins) {
        const features = await fetchSingleItem('', a, contentLevel, cache);
        allFeatures.push(...features);
    }

    return {
        type: 'FeatureCollection',
        features: allFeatures,
    };
}

// ---------- internal ----------

async function fetchSingleItem(
    name: string,
    admin: string,
    contentLevel: number,
    cache?: GadmCache
): Promise<GeoJSONFeature[]> {
    // Step 1: Look up the area to find its level + GID
    const lookupOpts = name ? { name } : { admin };
    const lookup = await getNames(lookupOpts);

    if (lookup.rows.length > 1) {
        const id = name || admin;
        throw new Error(
            `The requested name ("${id}") is not unique (${lookup.rows.length} results). ` +
            `Use the "admin" parameter instead. ` +
            `To find the GADM code, use: getNames({ name: "${id}" })`,
        );
    }

    const level = lookup.level;
    const gidCol = `GID_${level}`;
    const gadmId = lookup.rows[0][gidCol] || '';

    // Step 2: Resolve content level
    const contentLookup = await getNames({
        ...(name ? { name } : { admin }),
        contentLevel,
    });
    const resolvedLevel = contentLookup.level;

    // Step 3: Try local GeoPackage first
    let localResult = await tryLocalGpkg(gadmId, name || admin, level, resolvedLevel, cache);

    // Step 4: Fallback to GADM CDN
    if (!localResult) {
        localResult = await fetchFromCDN(name, admin, gadmId, level, resolvedLevel);
    }

    if (resolvedLevel === level) {
        localResult.forEach(f => f.properties.isOuter = true);
    }


    return localResult;
}

/**
 * Read boundaries from local GeoPackage.
 * Returns features with all matching rows at the resolved content level.
 */
async function tryLocalGpkg(
    gadmId: string,
    id: string,
    level: number,
    resolvedLevel: number,
    cache?: GadmCache,
): Promise<GeoJSONFeature[] | null> {
    // Query the GeoPackage for all rows belonging to this region
    const gidCol = `GID_${level}`;
    const nameCols: string[] = [];
    for (let l = 0; l <= Math.min(resolvedLevel, 5); l++) {
        nameCols.push(`NAME_${l}`, `GID_${l}`);
    }

    const result = await getBoundaryFromGpkg(gadmId, resolvedLevel, cache);
    if (!result || result.features.length === 0) return null;

    // Convert BoundaryFeature → GeoJSONFeature
    const features: GeoJSONFeature[] = result.features.map(f => ({
        type: 'Feature' as const,
        properties: f.properties,
        geometry: f.geometry,
    }));

    return features;
}

/**
 * Fallback: fetch from GADM CDN + correct names from parquet.
 */
async function fetchFromCDN(
    name: string,
    admin: string,
    gadmId: string,
    level: number,
    resolvedLevel: number,
): Promise<GeoJSONFeature[]> {
    const iso3 = gadmId.substring(0, 3);
    const url = GADM_URL.replace('{}', iso3).replace('{}', String(resolvedLevel));

    let data: any;
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
    } catch (e) {
        throw new Error(
            `Cannot retrieve data from GADM server. ` +
            `Try opening: ${url}. ` +
            `If it fails, the error is from GADM servers.`,
        );
    }

    // Convert to features
    const rawFeatures = data.features || [];
    let features: GeoJSONFeature[] = rawFeatures.map((f: any) => ({
        type: 'Feature' as const,
        properties: { ...f.properties, ...(f.properties?.COUNTRY ? { NAME_0: f.properties.COUNTRY } : {}) },
        geometry: f.geometry,
    }));

    // Name correction from parquet
    const isos = [...new Set(features.map(f => f.properties.GID_0).filter(Boolean))];
    if (isos.length > 0) {
        const completeRows = [];
        for (const iso of isos) {
            const nr = await getNames({ admin: iso, contentLevel: resolvedLevel, complete: true });
            completeRows.push(...nr.rows);
        }

        const gidKey = (row: Record<string, string>) => {
            const parts = [];
            for (let i = 0; i <= resolvedLevel; i++) {
                parts.push(row[`GID_${i}`] || '');
            }
            return parts.join('|');
        };

        const nameLookup = new Map<string, Record<string, string>>();
        for (const row of completeRows) {
            nameLookup.set(gidKey(row), row);
        }

        for (const feature of features) {
            const key = gidKey(feature.properties);
            const correct = nameLookup.get(key);
            if (correct) {
                for (let i = 0; i <= resolvedLevel; i++) {
                    if (correct[`NAME_${i}`]) {
                        feature.properties[`NAME_${i}`] = correct[`NAME_${i}`];
                    }
                }
            }
        }
    }

    // Filter to the requested area
    const id = name || admin;
    const colPrefix = name ? 'NAME_' : 'GID_';
    const filterCol = `${colPrefix}${level}`;
    features = features.filter(f =>
        f.properties[filterCol]?.toLowerCase() === id.toLowerCase(),
    );

    return features;
}
