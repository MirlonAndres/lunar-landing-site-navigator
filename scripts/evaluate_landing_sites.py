"""
Autonomous Lunar Landing Footprint Optimization and Safety Scoring Script
NASA Space Apps Challenge 2026

Searches the NASA LRO LOLA digital elevation model for optimal 100m diameter
circular landing footprints on Connecting Ridge. Applies multi-factor safety
constraints (slope stability, roughness clearance, elevation bias).
Exports top candidates to data/processed/optimal_landing_sites.json.

"""

import sys
import json
import time
from pathlib import Path
import tifffile

# Ensure repository root is in sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.core.terrain import TerrainAnalyzer
from src.core.safety import LandingSafetyEvaluator


def evaluate_candidate_touchdowns():
    raw_dem_path = REPO_ROOT / "data" / "raw" / "Site01_final_adj_5mpp_surf.tif"
    processed_dir = REPO_ROOT / "data" / "processed"

    print("==============================================================================")
    print("NASA LRO LOLA DEM - AUTONOMOUS LANDING SITE EVALUATION")
    print("AUTONOMOUS LANDING SITE EVALUATION - NASA LRO LOLA DEM")
    print(f"Target Region: Connecting Ridge (Shackleton Crater Rim)")
    print("==============================================================================\n")

    t0 = time.perf_counter()

    # Load raster
    # Cargar raster
    with tifffile.TiffFile(raw_dem_path) as tif:
        elevation = tif.pages[0].asarray()

    # Compute terrain metrics
    # Calcular metricas de terreno
    analyzer = TerrainAnalyzer(pixel_scale_m=5.0)
    slope_deg, _ = analyzer.compute_slope_and_aspect(elevation)
    roughness_m = analyzer.compute_roughness(elevation, window_size=5)

    # Initialize landing safety evaluator
    # Initialize landing safety evaluator
    evaluator = LandingSafetyEvaluator(
        pixel_scale_m=5.0,
        max_safe_slope_deg=15.0,
        max_safe_roughness_m=0.30,
        weight_slope=0.45,
        weight_roughness=0.35,
        weight_solar=0.10,
        weight_isru=0.10,
    )

    footprint_radius_m = 50.0  # 100m diameter footprint / Huella de 100m de diametro
    candidates = evaluator.find_optimal_landing_zones(
        elevation=elevation,
        slope_deg=slope_deg,
        roughness_m=roughness_m,
        footprint_radius_m=footprint_radius_m,
        num_candidates=5,
        min_distance_m=400.0,
    )

    t_end = time.perf_counter()

    print(f"Evaluated 10.24M terrain cells in: {t_end - t0:.3f} seconds\n")
    print("TOP 5 OPTIMAL LANDING FOOTPRINTS:")
    print("==============================================================================")

    output_list = []
    for c in candidates:
        output_list.append(c.to_dict())
        print(f"RANK #{c.rank}: {c.classification}")
        print(f"  Pixel Coord: [{c.pixel_y}, {c.pixel_x}] (Rel: X={c.rel_x_km:.2f} km, Y={c.rel_y_km:.2f} km)")
        print(f"  Elevation: {c.elevation_m:.1f} m")
        print(f"  Max Slope in 100m Footprint: {c.max_slope_deg:.2f} deg (Mean: {c.mean_slope_deg:.2f} deg)")
        print(f"  Mean Surface Roughness: {c.mean_roughness_m:.3f} m")
        print(f"  Slope Safety Score: {c.slope_score:.1f}/100")
        print(f"  Roughness Safety Score: {c.roughness_score:.1f}/100")
        print(f"  COMPOSITE SAFETY SCORE: {c.composite_safety_score:.2f}/100")
        print("------------------------------------------------------------------------------")

    # Export to JSON
    out_file = processed_dir / "optimal_landing_sites.json"
    with open(out_file, "w") as f:
        json.dump(output_list, f, indent=2)

    print(f"\n[PASS] Saved candidate landing sites to: {out_file.name}")
    print("Ready for mission trajectory and teleoperation simulation in Milestone 3.3.")


def main():
    evaluate_candidate_touchdowns()


if __name__ == "__main__":
    main()
