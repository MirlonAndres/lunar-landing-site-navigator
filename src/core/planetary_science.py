"""
Multi-Layer Lunar Planetary Science Module: Diviner Thermal and LEND ISRU Models
Modulo Cientifico Planetario Lunar Multicapa: Modelos Termicos Diviner e ISRU LEND
NASA Space Apps Challenge 2026 - Lunar Landing Site Navigator

Provides physical models for:
1. LRO Diviner Lunar Radiometer Experiment (DLRE) bolometric surface temperature.
   Determines cryogenic cold traps (T < 110K for H2O ice, T < 54K for super-volatiles).
2. LRO Lunar Exploration Neutron Detector (LEND) epithermal neutron flux suppression.
   Computes Water Equivalent Hydrogen (WEH wt%) and In-Situ Resource Utilization (ISRU) scores.

"""

from dataclasses import dataclass
from typing import Dict, Any, Tuple
import numpy as np


# Physical Constants / Constantes Fisicas
SOLAR_CONSTANT_W_M2 = 1361.0          # Solar irradiance at 1 AU / Irradiancia solar a 1 UA
STEFAN_BOLTZMANN = 5.670374419e-8     # Stefan-Boltzmann constant (W/(m^2 K^4))
LUNAR_REGOLITH_ALBEDO = 0.12          # Mean polar regolith albedo / Albedo polar medio
LUNAR_IR_EMISSIVITY = 0.95            # Thermal infrared emissivity / Emisividad termica IR
COSMIC_MICROWAVE_BACKGROUND_K = 2.725 # CMB temperature in Kelvin / Temperatura de fondo cosmico

# Volatile Thermal Stability Limits / Limites Termicos de Estabilidad de Volatiles
WATER_ICE_STABILITY_TEMP_K = 110.0    # Sublimation rate < 1mm/Gyr / Tasa de sublimacion < 1mm/Ga
SUPER_VOLATILE_TEMP_K = 54.0          # Trapping of CO2, NH3, CH4 / Atrapamiento de super-volatiles


@dataclass(frozen=True)
class ThermalState:
    """
    """
    surface_temp_k: float
    is_permanently_shadowed: bool
    is_water_ice_stable: bool
    is_super_volatile_stable: bool
    thermal_classification: str


@dataclass(frozen=True)
class ISRUResourceState:
    """
    """
    water_equivalent_hydrogen_wt_percent: float
    isru_potential_score: float
    estimated_ice_depth_cm: float
    resource_classification: str


class DivinerThermalModel:
    """
    """

    @staticmethod
    def compute_surface_temperature(
        solar_elevation_deg: float,
        slope_deg: float,
        aspect_deg: float,
        sun_azimuth_deg: float,
        is_terrain_shadowed: bool,
    ) -> ThermalState:
        """
        Compute bolometric surface temperature using radiative equilibrium.
        If shadowed, temperature is governed by infrared reradiation from crater walls (40K - 100K).
        If illuminated, temperature follows Stefan-Boltzmann law with local incidence angle.

        """
        if is_terrain_shadowed or solar_elevation_deg <= 0.0:
            # Permanently Shadowed Region (PSR) thermal balance
            # Equilibrio termico en Region en Sombra Permanente (PSR)
            # Equilibrium with deep space CMB and scattered infrared
            scattered_flux = 1.8 + 2.5 * max(0.0, np.sin(np.radians(slope_deg)))
            temp_k = float((scattered_flux / (LUNAR_IR_EMISSIVITY * STEFAN_BOLTZMANN)) ** 0.25)
            # Clamp between 38K and 95K according to Diviner ground-truth observations
            temp_k = float(np.clip(temp_k, 38.0, 95.0))
            is_psr = True
        else:
            # Illuminated surface: compute local solar incidence angle
            # Superficie iluminada: calcular angulo de incidencia solar local
            sun_elev_rad = np.radians(solar_elevation_deg)
            slope_rad = np.radians(slope_deg)
            rel_azimuth_rad = np.radians(sun_azimuth_deg - aspect_deg)

            cos_incidence = (
                np.sin(sun_elev_rad) * np.cos(slope_rad)
                + np.cos(sun_elev_rad) * np.sin(slope_rad) * np.cos(rel_azimuth_rad)
            )
            cos_incidence = max(0.001, float(cos_incidence))

            absorbed_solar_flux = (1.0 - LUNAR_REGOLITH_ALBEDO) * SOLAR_CONSTANT_W_M2 * cos_incidence
            temp_k = float((absorbed_solar_flux / (LUNAR_IR_EMISSIVITY * STEFAN_BOLTZMANN)) ** 0.25)
            temp_k = float(np.clip(temp_k, 115.0, 235.0))
            is_psr = False

        ice_stable = temp_k < WATER_ICE_STABILITY_TEMP_K
        super_stable = temp_k < SUPER_VOLATILE_TEMP_K

        if super_stable:
            classification = "Super-Cold Trap (CO2/CH4/H2O Stable) / Trampa Super-Fria"
        elif ice_stable:
            classification = "Cryogenic Cold Trap (H2O Ice Stable) / Trampa de Hielo H2O"
        elif temp_k < 150.0:
            classification = "Sub-Surface Ice Stable / Hielo Estable en Subsuelo"
        else:
            classification = "Thermally Desorbed Regolith / Regolito Desorbido Termicamente"

        return ThermalState(
            surface_temp_k=round(temp_k, 2),
            is_permanently_shadowed=is_psr,
            is_water_ice_stable=ice_stable,
            is_super_volatile_stable=super_stable,
            thermal_classification=classification,
        )


class LENDVolatileResourceModel:
    """
    """

    @staticmethod
    def evaluate_isru_potential(
        thermal_state: ThermalState,
        slope_deg: float,
        proximity_to_psr_km: float,
    ) -> ISRUResourceState:
        """
        Computes Water Equivalent Hydrogen (wt%) and ISRU viability score [0 to 100].
        Cold traps with low slope provide maximum extraction feasibility.

        """
        if thermal_state.is_super_volatile_stable:
            weh_wt = 1.25 + 0.35 * max(0.0, 1.0 - (proximity_to_psr_km / 2.0))
            ice_depth_cm = 5.0
            base_score = 95.0
        elif thermal_state.is_water_ice_stable:
            weh_wt = 0.75 + 0.25 * max(0.0, 1.0 - (proximity_to_psr_km / 3.0))
            ice_depth_cm = 15.0
            base_score = 80.0
        elif proximity_to_psr_km < 1.0:
            # Boundary transition zone (regolith with buried ice)
            # Zona de transicion (regolito con hielo sepultado)
            weh_wt = 0.30 + 0.15 * (1.0 - proximity_to_psr_km)
            ice_depth_cm = 45.0
            base_score = 60.0
        else:
            weh_wt = 0.05
            ice_depth_cm = 150.0
            base_score = 20.0

        # Terrain slope penalty: slopes > 15 deg reduce accessibility for rovers/extractors
        # Penalizacion por pendiente: pendientes > 15 deg reducen accesibilidad de rovers
        slope_penalty = max(0.0, (slope_deg - 10.0) * 2.5)
        isru_score = max(0.0, min(100.0, base_score - slope_penalty))

        if isru_score >= 80.0:
            classification = "Tier-1 Prime ISRU Mining Zone / Zona Primaria de Mineria ISRU"
        elif isru_score >= 55.0:
            classification = "Tier-2 Secondary Volatile Reserve / Reserva Secundaria de Volatiles"
        else:
            classification = "Tier-3 Resource Sparse Zone / Zona Pobre en Recursos"

        return ISRUResourceState(
            water_equivalent_hydrogen_wt_percent=round(float(weh_wt), 3),
            isru_potential_score=round(float(isru_score), 2),
            estimated_ice_depth_cm=round(float(ice_depth_cm), 1),
            resource_classification=classification,
        )
