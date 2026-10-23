import json
import rasterio
from rasterio.mask import mask
from rasterio.plot import show
import numpy as np
import os

TIFF_PATH = "data/ghs/GHS_BUILT_S_E2030_GLOBE_R2023A_54009_100_V1_0.tif"
JSON_PATH = "tests/tree/test-fua-barcelona.json"
OUT_PARAMS_PATH = "tests/tree/barcelona-builtup-stats.json"

def main():
    print(f"Loading Barcelona FUA geometry from {JSON_PATH}...")
    with open(JSON_PATH, "r") as f:
        data = json.load(f)
    
    # Extract the geometry (since the JSON we saved doesn't have the full geometry array,
    # wait, our fua.test.ts didn't save the full geometry, it only saved geometryInfo!
    pass

if __name__ == "__main__":
    main()
