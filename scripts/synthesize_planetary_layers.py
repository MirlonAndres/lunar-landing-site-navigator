"""
Artemis Candidate Sites Multi-Layer Planetary Science Synthesis Script
Script de Sintesis Multicapa de Ciencia Planetaria para Sitios Artemis
NASA Space Apps Challenge 2026

English:
Synthesizes NASA planetary datasets across all 4 candidate landing sites:
- LRO LOLA Topography (Elevation & Slope Hazard)
- NASA JPL Horizons Ephemerides (Solar Power & Earth DTE Communications)
- LRO Diviner DLRE (Cryogenic Surface Temperature & Cold Traps)
- LRO LEND (Water Equivalent Hydrogen wt% & ISRU Mining Viability)
Exports consolidated Parquet dataset to data/processed/.

Espanol:
Sintetiza conjuntos de datos planetarios de la NASA en los 4 sitios candidatos:
- Topografia LRO LOLA (Altimetria y Riesgo de Pendiente)
- Efemerides NASA JPL Horizons (Energia Solar y Telecomunicaciones DTE)
- LRO Diviner DLRE (Temperatura Criogenica Superficial y Trampas Frias)
- LRO LEND (Hidrogeno Equivalente a Agua % peso y Viabilidad Minera ISRU)
Exporta conjunto de datos Parquet consolidado a data/processed/.
"""

import sys
from pathlib import Path
import pandas as pd

# Ensure repository root is in sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.core.planetary_science import (
    DivinerThermalModel,
    LENDVolatileResourceModel,
)


def synthesize_all_sites() -> pd.DataFrame:
    """
    English: Evaluate and compare all 4 candidate Artemis landing sites.
    Espanol: Evaluar y comparar los 4 sitios candidatos de alunizaje de Artemis.
    """
    sites_data = [
        {
            "site_id": "site_01",
            "name_en": "Connecting Ridge (Shackleton Rim)",
            "name_es": "Cresta de Conexion (Borde de Shackleton)",
            "latitude_deg": -89.444,
            "longitude_deg": 222.050,
            "elevation_m": 1139.06,
            "mean_slope_deg": 8.5,
            "max_slope_deg": 14.2,
            "sun_illumination_pct": 50.82,
            "earth_dte_pct": 9.81,
            "proximity_to_psr_km": 0.45,
            "is_shadowed": False,
            "sun_elev_deg": 1.07,
            "aspect_deg": 210.0,
            "sun_az_deg": 215.0,
        },
        {
            "site_id": "site_02",
            "name_en": "North Peak (Peak near Shackleton)",
            "name_es": "Pico Norte (Pico cerca de Shackleton)",
            "latitude_deg": -89.540,
            "longitude_deg": 116.500,
            "elevation_m": 1959.50,
            "mean_slope_deg": 10.2,
            "max_slope_deg": 15.0,
            "sun_illumination_pct": 100.00,
            "earth_dte_pct": 10.85,
            "proximity_to_psr_km": 1.80,
            "is_shadowed": False,
            "sun_elev_deg": 1.04,
            "aspect_deg": 350.0,
            "sun_az_deg": 215.0,
        },
        {
            "site_id": "site_03",
            "name_en": "Malapert Mountain (Massif)",
            "name_es": "Montana de Malapert (Macizo)",
            "latitude_deg": -85.990,
            "longitude_deg": 357.500,
            "elevation_m": 4980.00,
            "mean_slope_deg": 12.8,
            "max_slope_deg": 22.4,
            "sun_illumination_pct": 92.50,
            "earth_dte_pct": 88.40,
            "proximity_to_psr_km": 8.50,
            "is_shadowed": False,
            "sun_elev_deg": 1.85,
            "aspect_deg": 15.0,
            "sun_az_deg": 215.0,
        },
        {
            "site_id": "site_04",
            "name_en": "Faustini Rim A (Cryogenic Cold Trap)",
            "name_es": "Borde de Faustini A (Trampa Fria Criogenica)",
            "latitude_deg": -87.200,
            "longitude_deg": 77.000,
            "elevation_m": -1420.00,
            "mean_slope_deg": 11.4,
            "max_slope_deg": 18.6,
            "sun_illumination_pct": 32.10,
            "earth_dte_pct": 4.50,
            "proximity_to_psr_km": 0.10,
            "is_shadowed": True,
            "sun_elev_deg": 0.45,
            "aspect_deg": 90.0,
            "sun_az_deg": 215.0,
        },
    ]

    records = []
    print("==============================================================================")
    print("ARTEMIS CANDIDATE SITES - MULTI-LAYER PLANETARY SCIENCE SYNTHESIS")
    print("SINTESIS MULTICAPA DE CIENCIA PLANETARIA - SITIOS ARTEMIS")
    print("==============================================================================\n")

    for s in sites_data:
        thermal = DivinerThermalModel.compute_surface_temperature(
            solar_elevation_deg=s["sun_elev_deg"],
            slope_deg=s["mean_slope_deg"],
            aspect_deg=s["aspect_deg"],
            sun_azimuth_deg=s["sun_az_deg"],
            is_terrain_shadowed=s["is_shadowed"],
        )

        isru = LENDVolatileResourceModel.evaluate_isru_potential(
            thermal_state=thermal,
            slope_deg=s["mean_slope_deg"],
            proximity_to_psr_km=s["proximity_to_psr_km"],
        )

        # Composite Landing Suitability Index (0 to 100)
        # Indice de Idoneidad Compuesto para Alunizaje (0 a 100)
        # Weights: Slope (30%), Solar (30%), DTE (20%), ISRU (20%)
        # Pesos: Pendiente (30%), Solar (30%), DTE (20%), ISRU (20%)
        slope_score = max(0.0, 100.0 - (s["mean_slope_deg"] / 15.0) * 100.0)
        solar_score = s["sun_illumination_pct"]
        dte_score = s["earth_dte_pct"]
        isru_score = isru.isru_potential_score

        composite_score = (
            0.30 * slope_score +
            0.30 * solar_score +
            0.20 * dte_score +
            0.20 * isru_score
        )

        rec = {
            "site_id": s["site_id"],
            "name_en": s["name_en"],
            "name_es": s["name_es"],
            "latitude_deg": s["latitude_deg"],
            "longitude_deg": s["longitude_deg"],
            "elevation_m": s["elevation_m"],
            "mean_slope_deg": s["mean_slope_deg"],
            "sun_illumination_pct": s["sun_illumination_pct"],
            "earth_dte_pct": s["earth_dte_pct"],
            "proximity_to_psr_km": s["proximity_to_psr_km"],
            "diviner_surface_temp_k": thermal.surface_temp_k,
            "is_water_ice_stable": thermal.is_water_ice_stable,
            "lend_weh_wt_pct": isru.water_equivalent_hydrogen_wt_percent,
            "isru_potential_score": isru.isru_potential_score,
            "landing_suitability_score": round(composite_score, 2),
            "thermal_classification": thermal.thermal_classification,
            "isru_classification": isru.resource_classification,
        }
        records.append(rec)

        print(f"SITE / SITIO: {s['name_en']}")
        print(f"  Coordinates / Coordenadas: Lat {s['latitude_deg']:.3f} deg, Lon {s['longitude_deg']:.3f} deg")
        print(f"  Elevation / Elevacion: {s['elevation_m']:.1f} m | Mean Slope / Pendiente Media: {s['mean_slope_deg']:.1f} deg")
        print(f"  Solar Illumination / Iluminacion Solar: {s['sun_illumination_pct']:.2f}% | Earth DTE / Enlace DTE: {s['earth_dte_pct']:.2f}%")
        print(f"  Diviner Surface Temp / Temp Diviner: {thermal.surface_temp_k:.1f} K ({thermal.thermal_classification})")
        print(f"  LEND WEH Hydrogen / Hidrogeno WEH: {isru.water_equivalent_hydrogen_wt_percent:.3f} wt% | ISRU Score: {isru.isru_potential_score:.1f}/100")
        print(f"  COMPOSITE SUITABILITY SCORE / INDICE DE IDONEIDAD: {composite_score:.2f}/100")
        print("------------------------------------------------------------------------------")

    df_result = pd.DataFrame(records)
    out_path = REPO_ROOT / "data" / "processed" / "artemis_sites_planetary_synthesis.parquet"
    df_result.to_parquet(out_path, index=False)
    print(f"\n[PASS] Saved multi-layer synthesis to / Guardado en: {out_path.name}")
    return df_result


def main():
    synthesize_all_sites()


if __name__ == "__main__":
    main()
