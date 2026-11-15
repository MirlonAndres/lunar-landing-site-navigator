"""
Lunar Terrain Metrics Processing and Hazard Benchmark Script
Script de Procesamiento de Metricas de Terreno Lunar y Benchmark de Peligros
NASA Space Apps Challenge 2026

Executes the scientific terrain analysis pipeline over NASA LRO LOLA DEM:
- Calculates 2D spatial slope gradients and aspect angles.
- Computes surface roughness via moving window standard deviation.
- Performs automated 3-tier landing hazard classification (Safe / Caution / Hazard).
- Generates optimized low-resolution 3D heightmap for WebGL digital twin.
- Measures computational execution benchmarks.

"""

import sys
import time
import json
from pathlib import Path
import numpy as np
import tifffile

# Ensure repository root is in sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.core.terrain import TerrainAnalyzer


def process_dem_pipeline():
    raw_dem_path = REPO_ROOT / "data" / "raw" / "Site01_final_adj_5mpp_surf.tif"
    processed_dir = REPO_ROOT / "data" / "processed"

    print("==============================================================================")
    print("LUNAR TERRAIN SCIENTIFIC COMPUTATION PIPELINE")
    print("PIPELINE CIENTIFICO DE COMPUTO DE TERRENO LUNAR")
    print(f"Input DEM: {raw_dem_path.name}")
    print("==============================================================================\n")

    t0 = time.perf_counter()

    # Step 1: Ingest GeoTIFF
    # Paso 1: Ingestar GeoTIFF
    print("1. LOADING ELEVATION RASTER...")
    with tifffile.TiffFile(raw_dem_path) as tif:
        elevation = tif.pages[0].asarray()
    t_load = time.perf_counter()
    print(f"Loaded shape: {elevation.shape} ({elevation.size:,} pixels) in {t_load - t0:.3f} s")

    # Step 2: Initialize Analyzer and compute slope & aspect
    # Paso 2: Inicializar analizador y calcular pendiente y aspect
    print("\n2. COMPUTING 2D SLOPE GRADIENTS...")
    analyzer = TerrainAnalyzer(pixel_scale_m=5.0)
    slope_deg, aspect_deg = analyzer.compute_slope_and_aspect(elevation)
    t_slope = time.perf_counter()
    print(f"Slope computation complete in: {t_slope - t_load:.3f} s")
    print(f"  Slope Range: {np.min(slope_deg):.2f} deg to / a {np.max(slope_deg):.2f} deg")
    print(f"  Mean Slope: {np.mean(slope_deg):.2f} deg")
    print(f"  Median Slope: {np.median(slope_deg):.2f} deg")

    # Step 3: Compute surface roughness
    # Paso 3: Calcular rugosidad superficial
    print("\n3. COMPUTING SURFACE ROUGHNESS...")
    roughness_m = analyzer.compute_roughness(elevation, window_size=5)
    t_rough = time.perf_counter()
    print(f"Roughness computation complete in: {t_rough - t_slope:.3f} s")
    print(f"  Roughness Range: {np.min(roughness_m):.3f} m to / a {np.max(roughness_m):.3f} m")
    print(f"  Mean Roughness: {np.mean(roughness_m):.3f} m")

    # Step 4: Classify landing hazards
    # Paso 4: Clasificar riesgos de aterrizaje
    print("\n4. CLASSIFYING LANDING HAZARDS...")
    hazard_map = analyzer.classify_hazard_zones(
        slope_deg, roughness_m, max_safe_slope=15.0, max_safe_roughness=0.30
    )
    t_hazard = time.perf_counter()
    print(f"Hazard classification complete in: {t_hazard - t_rough:.3f} s")

    total_pixels = hazard_map.size
    safe_pct = float(np.count_nonzero(hazard_map == 0) / total_pixels * 100.0)
    caution_pct = float(np.count_nonzero(hazard_map == 1) / total_pixels * 100.0)
    hazard_pct = float(np.count_nonzero(hazard_map == 2) / total_pixels * 100.0)

    print(f"  SAFE Zones / Zonas SEGURAS (Slope <= 15°, Roughness <= 0.30m): {safe_pct:.2f}% ({safe_pct * 256.0 / 100.0:.2f} km^2)")
    print(f"  CAUTION Zones / Zonas PRECAUCION (12°-15° or marginal): {caution_pct:.2f}% ({caution_pct * 256.0 / 100.0:.2f} km^2)")
    print(f"  HAZARD Zones / Zonas PELIGRO (Slope > 15° or rough): {hazard_pct:.2f}% ({hazard_pct * 256.0 / 100.0:.2f} km^2)")

    # Step 5: Downsample for real-time 3D WebGL Digital Twin
    # Paso 5: Submuestrear para Gemelo Digital 3D WebGL en tiempo real
    print("\n5. DOWNSAMPLING FOR 3D WEBGL RENDERING...")
    target_dim = (256, 256)
    dem_lowres = analyzer.downsample_terrain(elevation, target_shape=target_dim)
    slope_lowres = analyzer.downsample_terrain(slope_deg, target_shape=target_dim)
    t_down = time.perf_counter()
    print(f"Generated {target_dim[0]}x{target_dim[1]} low-res mesh in: {t_down - t_hazard:.3f} s")

    # Step 6: Export processed summary JSON
    # Paso 6: Exportar resumen procesado JSON
    summary_data = {
        "dataset_name": "LRO_LOLA_DEM_5MPP_SITE01",
        "spatial_coverage_km": {"width_km": 16.0, "height_km": 16.0, "total_area_km2": 256.0},
        "elevation_m": {
            "min_m": float(np.min(elevation)),
            "max_m": float(np.max(elevation)),
            "mean_m": float(np.mean(elevation)),
            "relief_m": float(np.max(elevation) - np.min(elevation)),
        },
        "slope_deg": {
            "min_deg": float(np.min(slope_deg)),
            "max_deg": float(np.max(slope_deg)),
            "mean_deg": float(np.mean(slope_deg)),
            "median_deg": float(np.median(slope_deg)),
        },
        "roughness_m": {
            "min_m": float(np.min(roughness_m)),
            "max_m": float(np.max(roughness_m)),
            "mean_m": float(np.mean(roughness_m)),
        },
        "hazard_distribution_pct": {
            "safe_pct": round(safe_pct, 2),
            "caution_pct": round(caution_pct, 2),
            "hazard_pct": round(hazard_pct, 2),
            "safe_area_km2": round(safe_pct * 256.0 / 100.0, 2),
        },
        "benchmarks_sec": {
            "io_load": round(t_load - t0, 3),
            "slope_calc": round(t_slope - t_load, 3),
            "roughness_calc": round(t_rough - t_slope, 3),
            "hazard_calc": round(t_hazard - t_rough, 3),
            "downsample_calc": round(t_down - t_hazard, 3),
            "total_pipeline": round(t_down - t0, 3),
        },
    }

    summary_file = processed_dir / "terrain_metrics_summary.json"
    with open(summary_file, "w") as f:
        json.dump(summary_data, f, indent=2)

    # Export low-res heightmap for Three.js 3D terrain
    mesh_export = {
        "rows": target_dim[0],
        "cols": target_dim[1],
        "min_elev": float(np.min(dem_lowres)),
        "max_elev": float(np.max(dem_lowres)),
        "heights": dem_lowres.round(1).tolist(),
        "slopes": slope_lowres.round(1).tolist(),
    }
    mesh_file = processed_dir / "terrain_3d_mesh.json"
    with open(mesh_file, "w") as f:
        json.dump(mesh_export, f)

    print(f"\n[PASS] Saved summary to: {summary_file.name}")
    print(f"[PASS] Saved 3D mesh to / Guardada malla 3D en: {mesh_file.name}")
    print(f"TOTAL PIPELINE BENCHMARK: {t_down - t0:.3f} seconds for 10.24M elevation points!")
    print("Ready for safety landing zone selection in Milestone 3.2.")


def main():
    process_dem_pipeline()


if __name__ == "__main__":
    main()
