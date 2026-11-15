"""
Terrain Illumination and Permanently Shadowed Region (PSR) Ray-Casting
Trazado de Rayos de Iluminacion de Terreno y Regiones en Sombra Permanente (PSR)
NASA Space Apps Challenge 2026 - Lunar Landing Site Navigator

Computes, for every cell of the 256x256 LOLA heightmap (62.5 m/pixel), the terrain
horizon angle along each azimuth by marching rays across the DEM. Two products:
  1. Mission illumination fraction: share of the 7-day JPL Horizons sun trajectory
     (real azimuth + elevation) during which the cell sees the solar disk center.
  2. PSR / cold-trap mask: cells whose horizon exceeds the maximum polar sun
     elevation (1.6 deg) at every azimuth -> never illuminated -> volatile ice traps.

"""

import json
import sys
import time
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

PROCESSED = REPO_ROOT / "data" / "processed"
PIXEL_M = 16000.0 / 256.0          # 62.5 m per heightmap cell / metros por celda
MAX_STEPS = 128                    # Ray length: 8 km: 8 km
MAX_POLAR_SUN_ELEV_DEG = 1.6       # Max solar elevation at lunar south pole / Elevacion solar maxima


def horizon_angle_map(heights: np.ndarray, azimuth_deg: float) -> np.ndarray:
    """
    English: Maximum terrain elevation angle (deg) seen from each cell toward azimuth.
    """
    rows, cols = heights.shape
    az = np.radians(azimuth_deg)
    dir_c = np.sin(az)     # +col = east / este
    dir_r = -np.cos(az)    # -row = north / norte
    max_tan = np.full(heights.shape, -np.inf, dtype=np.float32)

    rr, cc = np.mgrid[0:rows, 0:cols]
    for k in range(1, MAX_STEPS + 1):
        tr = np.rint(rr + dir_r * k).astype(np.int32)
        tc = np.rint(cc + dir_c * k).astype(np.int32)
        valid = (tr >= 0) & (tr < rows) & (tc >= 0) & (tc < cols)
        if not valid.any():
            break
        target = np.where(valid, heights[np.clip(tr, 0, rows - 1), np.clip(tc, 0, cols - 1)], -np.inf)
        dist = k * PIXEL_M
        tan_k = (target - heights) / dist
        np.maximum(max_tan, tan_k, out=max_tan)

    max_tan[np.isinf(max_tan)] = -1.0
    return np.degrees(np.arctan(max_tan))


def main():
    t0 = time.perf_counter()
    mesh = json.load(open(PROCESSED / "terrain_3d_mesh.json"))
    heights = np.asarray(mesh["heights"], dtype=np.float32)
    timeline = json.load(open(PROCESSED / "mission_timeline_simulation.json"))
    traj = timeline["sample_trajectory"]

    print("==============================================================================")
    print("TERRAIN ILLUMINATION RAY-CASTING")
    print(f"Grid: {heights.shape} @ {PIXEL_M:.1f} m/px | Sun samples: {len(traj)}")
    print("==============================================================================")

    # 1. Mission illumination over real 7-day trajectory (2-degree azimuth bins cache)
    # 1. Iluminacion de mision sobre la trayectoria real de 7 dias (cache por bins de 2 grados)
    cache = {}
    lit_count = np.zeros(heights.shape, dtype=np.float32)
    for p in traj:
        az_bin = round(p["sun_az"] / 2.0) * 2.0
        if az_bin not in cache:
            cache[az_bin] = horizon_angle_map(heights, az_bin)
        lit_count += (p["sun_elev"] > cache[az_bin]).astype(np.float32)
    illum_frac = lit_count / len(traj)

    # 2. PSR mask over all 72 azimuths at maximum polar sun elevation
    # 2. Mascara PSR en 72 azimuts con la elevacion solar polar maxima
    ever_lit = np.zeros(heights.shape, dtype=bool)
    for az in np.arange(0.0, 360.0, 5.0):
        hmap = cache.get(az) if az in cache else horizon_angle_map(heights, az)
        ever_lit |= (MAX_POLAR_SUN_ELEV_DEG > hmap)
    psr = ~ever_lit

    elapsed = time.perf_counter() - t0
    print(f"Mean mission illumination: {illum_frac.mean() * 100:.1f}%")
    print(f"Cells lit > 80% / Celdas con > 80% luz: {(illum_frac > 0.8).mean() * 100:.2f}%")
    print(f"PSR cold-trap area: {psr.mean() * 256:.2f} km2 ({psr.mean() * 100:.2f}%)")
    print(f"Elapsed: {elapsed:.2f} s")

    out = {
        "rows": int(heights.shape[0]),
        "cols": int(heights.shape[1]),
        "pixel_m": PIXEL_M,
        "max_polar_sun_elev_deg": MAX_POLAR_SUN_ELEV_DEG,
        "mean_illumination_pct": round(float(illum_frac.mean() * 100), 2),
        "psr_area_km2": round(float(psr.mean() * 256.0), 2),
        "illumination": np.round(illum_frac, 2).tolist(),
        "psr": psr.astype(np.uint8).tolist(),
    }
    out_path = PROCESSED / "terrain_illumination.json"
    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"[PASS] Saved: {out_path.name}")


if __name__ == "__main__":
    main()
