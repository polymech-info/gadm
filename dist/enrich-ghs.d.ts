export interface GHSEnrichOptions {
    pop?: boolean | string;
    built?: boolean | string;
    popTiffPath?: string;
    builtTiffPath?: string;
}
export interface GHSEnrichResult {
    ghsPopulation?: number;
    ghsPopMaxDensity?: number;
    ghsPopCenter?: [number, number];
    ghsPopCenters?: [number, number, number][];
    ghsBuiltWeight?: number;
    ghsBuiltMax?: number;
    ghsBuiltCenter?: [number, number];
    ghsBuiltCenters?: [number, number, number][];
}
export declare function enrichFeatureWithGHS(feature: any, options: GHSEnrichOptions): Promise<GHSEnrichResult>;
