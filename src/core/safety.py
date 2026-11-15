"""
Multi-Criteria Lunar Landing Safety Evaluator and Footprint Optimizer
NASA Space Apps Challenge 2026 - Lunar Landing Site Navigator

Provides autonomous landing safety scoring and candidate touchdown footprint
search algorithms based on NASA landing engineering constraints:
1. Slope stability: Hard rejection if max slope > 15.0 deg within 100m footprint.
2. Roughness clearance: Hard rejection if roughness std > 0.30m (boulder risk).
3. Illumination continuity: Solar photovoltaic energy score.
4. ISRU scientific value: Proximity to Permanently Shadowed Region (PSR) cold traps.

"""

from dataclasses import dataclass, asdict
from typing import List, Dict, Any, Tuple
import numpy as np
from scipy import ndimage


@dataclass(frozen=True)
class LandingSiteCandidate:
    """
    """
    rank: int
    pixel_y: int
    pixel_x: int
    rel_x_km: float
    rel_y_km: float
    elevation_m: float
    max_slope_deg: float
    mean_slope_deg: float
    mean_roughness_m: float
    slope_score: float
    roughness_score: float
    composite_safety_score: float
    proximity_to_psr_km: float
    classification: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class LandingSafetyEvaluator:
    """
    """

    def __init__(
        self,
        pixel_scale_m: float = 5.0,
        max_safe_slope_deg: float = 15.0,
        max_safe_roughness_m: float = 0.30,
        weight_slope: float = 0.45,
        weight_roughness: float = 0.35,
        weight_solar: float = 0.10,
        weight_isru: float = 0.10,
    ):
        self.pixel_scale_m = float(pixel_scale_m)
        self.max_safe_slope = float(max_safe_slope_deg)
        self.max_safe_roughness = float(max_safe_roughness_m)

        # Normalize weights to sum to 1.0
        # Normalizar pesos para que sumen 1.0
        total_w = weight_slope + weight_roughness + weight_solar + weight_isru
        self.w_slope = weight_slope / total_w
        self.w_rough = weight_roughness / total_w
        self.w_solar = weight_solar / total_w
        self.w_isru = weight_isru / total_w

    def score_slope(self, slope_deg: float) -> float:
        """
        """
        if slope_deg > self.max_safe_slope:
            return 0.0
        if slope_deg <= 5.0:
            return 100.0
        return float(100.0 * (self.max_safe_slope - slope_deg) / (self.max_safe_slope - 5.0))

    def score_roughness(self, roughness_m: float) -> float:
        """
        """
        if roughness_m > self.max_safe_roughness:
            return 0.0
        if roughness_m <= 0.10:
            return 100.0
        return float(100.0 * (self.max_safe_roughness - roughness_m) / (self.max_safe_roughness - 0.10))

    def find_optimal_landing_zones(
        self,
        elevation: np.ndarray,
        slope_deg: np.ndarray,
        roughness_m: np.ndarray,
        footprint_radius_m: float = 50.0,
        num_candidates: int = 5,
        min_distance_m: float = 300.0,
    ) -> List[LandingSiteCandidate]:
        """
        Finds the top N discrete landing site footprints within the DEM.
        Applies a circular footprint kernel and suppresses duplicate nearby sites.

        """
        radius_px = max(1, int(round(footprint_radius_m / self.pixel_scale_m)))
        min_dist_px = max(1, int(round(min_distance_m / self.pixel_scale_m)))

        # Create circular footprint structuring element
        # Crear elemento estructurante circular para el area de contacto
        y_grid, x_grid = np.ogrid[-radius_px:radius_px + 1, -radius_px:radius_px + 1]
        footprint_mask = (x_grid**2 + y_grid**2) <= radius_px**2

        # Compute maximum slope and mean roughness across the footprint
        # Calcular pendiente maxima y rugosidad media en el area de contacto
        footprint_max_slope = ndimage.maximum_filter(slope_deg, footprint=footprint_mask)
        footprint_mean_slope = ndimage.uniform_filter(slope_deg, size=radius_px * 2 + 1)
        footprint_mean_roughness = ndimage.uniform_filter(roughness_m, size=radius_px * 2 + 1)

        # Vectorized safety scoring
        # Puntuacion de seguridad vectorizada
        valid_mask = (footprint_max_slope <= self.max_safe_slope) & (
            footprint_mean_roughness <= self.max_safe_roughness
        )

        # Approximate PSR proximity (distance to lowest elevation floor)
        # Proximidad aproximada a PSR (distancia al fondo del crater)
        h, w = elevation.shape
        center_y, center_x = h // 2, w // 2

        score_map = np.zeros_like(elevation, dtype=np.float32)

        slope_scores = np.where(
            footprint_max_slope <= 5.0,
            100.0,
            np.clip(100.0 * (self.max_safe_slope - footprint_max_slope) / (self.max_safe_slope - 5.0), 0.0, 100.0)
        )

        rough_scores = np.where(
            footprint_mean_roughness <= 0.10,
            100.0,
            np.clip(100.0 * (self.max_safe_roughness - footprint_mean_roughness) / (self.max_safe_roughness - 0.10), 0.0, 100.0)
        )

        # Elevation bias: higher terrain on Connecting Ridge has higher illumination
        # Sesgo de elevacion: terreno mas alto en la cresta tiene mayor iluminacion
        elev_min = np.min(elevation)
        elev_max = np.max(elevation)
        elev_norm = (elevation - elev_min) / max(1.0, elev_max - elev_min) * 100.0

        score_map = np.where(
            valid_mask,
            (self.w_slope * slope_scores + self.w_rough * rough_scores + (self.w_solar + self.w_isru) * elev_norm),
            0.0
        )

        # Exclude borders where footprint extends out of bounds
        # Excluir bordes donde el footprint sobresale
        margin = radius_px + 2
        score_map[:margin, :] = 0.0
        score_map[-margin:, :] = 0.0
        score_map[:, :margin] = 0.0
        score_map[:, -margin:] = 0.0

        candidates: List[LandingSiteCandidate] = []
        temp_scores = score_map.copy()

        for rank_idx in range(1, num_candidates + 1):
            max_idx = np.argmax(temp_scores)
            py, px = np.unravel_index(max_idx, temp_scores.shape)
            best_score = float(temp_scores[py, px])

            if best_score <= 0.0:
                break

            # Calculate relative km from image center
            # Calcular kilometros relativos desde el centro de la imagen
            rel_x_km = float((px - center_x) * self.pixel_scale_m / 1000.0)
            rel_y_km = float((py - center_y) * self.pixel_scale_m / 1000.0)
            dist_to_center_km = float(np.sqrt(rel_x_km**2 + rel_y_km**2))

            site_slope_score = float(slope_scores[py, px])
            site_rough_score = float(rough_scores[py, px])

            candidate = LandingSiteCandidate(
                rank=rank_idx,
                pixel_y=int(py),
                pixel_x=int(px),
                rel_x_km=round(rel_x_km, 3),
                rel_y_km=round(rel_y_km, 3),
                elevation_m=round(float(elevation[py, px]), 2),
                max_slope_deg=round(float(footprint_max_slope[py, px]), 2),
                mean_slope_deg=round(float(footprint_mean_slope[py, px]), 2),
                mean_roughness_m=round(float(footprint_mean_roughness[py, px]), 3),
                slope_score=round(site_slope_score, 1),
                roughness_score=round(site_rough_score, 1),
                composite_safety_score=round(best_score, 2),
                proximity_to_psr_km=round(dist_to_center_km, 2),
                classification="PRIME LANDING FOOTPRINT" if rank_idx == 1 else "BACKUP TOUCHDOWN ZONE",
            )
            candidates.append(candidate)

            # Suppress region around this candidate to enforce spatial diversity
                        y_min = max(0, py - min_dist_px)
            y_max = min(h, py + min_dist_px + 1)
            x_min = max(0, px - min_dist_px)
            x_max = min(w, px + min_dist_px + 1)
            temp_scores[y_min:y_max, x_min:x_max] = 0.0

        return candidates
