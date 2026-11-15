"""
Lunar Terrain Geomorphometry and Hazard Matrix Computation Engine
Motor de Calculo de Geomorfometria y Matriz de Peligros de Terreno Lunar
NASA Space Apps Challenge 2026 - Lunar Landing Site Navigator

English:
Provides vectorized high-performance scientific computation of lunar surface
slope gradient, terrain aspect, local roughness standard deviation, and landing
safety zone classification directly from NASA LRO LOLA digital elevation models.

Espanol:
Proporciona computo cientifico vectorizado de alto rendimiento para gradientes de
pendiente lunar, orientacion de laderas (aspect), desviacion estandar de rugosidad
local y clasificacion de zonas de seguridad de alunizaje directamente desde modelos
digitales de elevacion LRO LOLA de la NASA.
"""

from typing import Tuple, Dict, Any, Optional
import numpy as np
from scipy import ndimage


class TerrainAnalyzer:
    """
    English: Core scientific engine for digital elevation model (DEM) analysis.
    Espanol: Motor cientifico central para analisis de modelos digitales de elevacion (DEM).
    """

    def __init__(self, pixel_scale_m: float = 5.0):
        """
        English: Initialize analyzer with spatial resolution (default: 5 meters/pixel).
        Espanol: Inicializar analizador con resolucion espacial (defecto: 5 metros/pixel).
        """
        self.pixel_scale_m = float(pixel_scale_m)

    def compute_slope_and_aspect(
        self, elevation: np.ndarray
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        English:
        Compute slope in degrees and aspect in degrees using 2D Sobel spatial gradients.
        Slope: arctan(sqrt(dz_dx^2 + dz_dy^2)) * 180 / pi
        Aspect: azimuth direction of steepest downward descent [0 to 360 deg].

        Espanol:
        Calcula la pendiente en grados y la orientacion (aspect) usando gradientes espaciales Sobel 2D.
        Pendiente: arctan(sqrt(dz_dx^2 + dz_dy^2)) * 180 / pi
        Aspect: direccion azimutal de maxima pendiente descendente [0 a 360 grados].
        """
        # Sobel spatial convolution kernels normalized by grid resolution
        # Convolucion espacial Sobel normalizada por la resolucion de grilla
        dz_dx = ndimage.sobel(elevation, axis=1) / (8.0 * self.pixel_scale_m)
        dz_dy = ndimage.sobel(elevation, axis=0) / (8.0 * self.pixel_scale_m)

        gradient_magnitude = np.sqrt(dz_dx**2 + dz_dy**2)
        slope_deg = np.degrees(np.arctan(gradient_magnitude))

        # Aspect calculation: angle of maximum descent from North (clockwise)
        # Calculo de aspect: angulo de descenso maximo desde el Norte (horario)
        aspect_rad = np.arctan2(-dz_dx, dz_dy)
        aspect_deg = np.degrees(aspect_rad) % 360.0

        return slope_deg.astype(np.float32), aspect_deg.astype(np.float32)

    def compute_roughness(
        self, elevation: np.ndarray, window_size: int = 5
    ) -> np.ndarray:
        """
        English:
        Compute surface roughness as the local standard deviation within a moving window.
        Uses O(N) uniform box filters: sqrt(max(0, E[Z^2] - (E[Z])^2)).

        Espanol:
        Calcula la rugosidad superficial como la desviacion estandar local en ventana movil.
        Utiliza filtros uniformes O(N): sqrt(max(0, E[Z^2] - (E[Z])^2)).
        """
        win = int(window_size)
        mean_z = ndimage.uniform_filter(elevation, size=win, mode="reflect")
        mean_z2 = ndimage.uniform_filter(elevation**2, size=win, mode="reflect")
        variance = np.maximum(0.0, mean_z2 - mean_z**2)
        roughness = np.sqrt(variance)
        return roughness.astype(np.float32)

    def classify_hazard_zones(
        self,
        slope_deg: np.ndarray,
        roughness_m: np.ndarray,
        max_safe_slope: float = 15.0,
        max_safe_roughness: float = 0.30,
    ) -> np.ndarray:
        """
        English:
        Classify terrain into 3 operational landing hazard tiers:
        0 = SAFE (Green): Slope <= max_safe_slope and Roughness <= max_safe_roughness
        1 = CAUTION (Yellow): Slope between (max - 3°) and max, or marginal roughness
        2 = HAZARD (Red): Slope > max_safe_slope or Roughness > max_safe_roughness

        Espanol:
        Clasifica el terreno en 3 niveles de riesgo operativo para alunizaje:
        0 = SEGURO (Verde): Pendiente <= max_safe_slope y Rugosidad <= max_safe_roughness
        1 = PRECAUCION (Amarillo): Pendiente entre (max - 3°) y max, o rugosidad marginal
        2 = PELIGRO (Rojo): Pendiente > max_safe_slope o Rugosidad > max_safe_roughness
        """
        hazard_map = np.zeros_like(slope_deg, dtype=np.uint8)

        # Caution criteria: slope within 3 deg of limit or roughness near threshold
        # Criterio de precaucion: pendiente a menos de 3 deg del limite o rugosidad cercana
        caution_mask = (
            (slope_deg > (max_safe_slope - 3.0)) & (slope_deg <= max_safe_slope)
        ) | (
            (roughness_m > (max_safe_roughness * 0.70)) & (roughness_m <= max_safe_roughness)
        )
        hazard_map[caution_mask] = 1

        # Hazard criteria: exceeds critical stability limits
        # Criterio de peligro: supera los limites criticos de estabilidad
        danger_mask = (slope_deg > max_safe_slope) | (roughness_m > max_safe_roughness)
        hazard_map[danger_mask] = 2

        return hazard_map

    def downsample_terrain(
        self, elevation: np.ndarray, target_shape: Tuple[int, int] = (256, 256)
    ) -> np.ndarray:
        """
        English:
        Downsamples high-resolution elevation grid to target shape for real-time 3D WebGL rendering.

        Espanol:
        Submuestrea la grilla de elevacion de alta resolucion a la resolucion objetivo para WebGL 3D.
        """
        zoom_y = target_shape[0] / elevation.shape[0]
        zoom_x = target_shape[1] / elevation.shape[1]
        downsampled = ndimage.zoom(elevation, (zoom_y, zoom_x), order=1)
        return downsampled.astype(np.float32)
