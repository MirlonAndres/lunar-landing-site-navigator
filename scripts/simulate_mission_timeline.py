"""
Mission Power, Articulated Sun-Tracking, and DTE Communication Simulation Script
Script de Simulacion de Potencia, Seguimiento Solar y Enlace DTE de Mision
NASA Space Apps Challenge 2026

Executes full 7-day mission operational simulation comparing fixed vs. articulated
sun-tracking solar panels on Connecting Ridge and North Peak. Calculates battery
state-of-charge, survival heating requirements, and direct-to-Earth contact schedules.
Exports mission timeline to data/processed/mission_timeline_simulation.json.

"""

import sys
import json
import time
from pathlib import Path
import pandas as pd

# Ensure repository root is in sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.core.mission import MissionSimulator


def run_mission_simulation():
    processed_dir = REPO_ROOT / "data" / "processed"
    ephem_path = processed_dir / "ephemeris_shackleton_terrain_validated.parquet"

    print("==============================================================================")
    print("LUNAR MISSION OPERATIONAL POWER AND COMMUNICATIONS SIMULATOR")
    print("SIMULADOR OPERATIVO DE POTENCIA Y COMUNICACIONES DE MISION LUNAR")
    print("Target Site: Connecting Ridge (Shackleton Rim - Site 01)")
    print("==============================================================================\n")

    if not ephem_path.exists():
        raise FileNotFoundError(f"Missing validated ephemeris: {ephem_path}")

    ephem_df = pd.read_parquet(ephem_path)
    simulator = MissionSimulator(
        solar_panel_area_m2=0.50,
        panel_efficiency=0.30,
        battery_capacity_wh=5000.0,     # 5 kWh Li-ion pack sized for ~80 h polar shadow / Bateria para ~80 h de sombra
        nominal_base_load_w=50.0,
        teleop_arm_load_w=20.0,
        survival_heater_load_w=25.0,
        hibernation_base_load_w=15.0,
    )

    t0 = time.perf_counter()
    sim_df, summary, comm_windows = simulator.simulate_power_and_communications(ephem_df)
    t_end = time.perf_counter()

    print("1. POWER SUBSYSTEM SIMULATION RESULTS")
    print("------------------------------------------------------------------------------")
    print(f"Simulation Duration: {summary.total_simulation_hours:.1f} hours ({summary.total_simulation_hours / 24.0:.1f} days)")
    print(f"Fixed Horizontal Panel Energy: {summary.fixed_panel_energy_wh:.1f} Wh")
    print(f"5-DOF Articulated Tracking Array: {summary.tracking_panel_energy_wh:.1f} Wh")
    print(f"ENERGY MULTIPLIER: {summary.tracking_efficiency_gain_ratio:.1f}x MORE ENERGY CAPTURED!")
    print(f"Min Battery State of Charge: {summary.min_battery_soc_pct:.1f}%")
    print(f"Max Battery State of Charge: {summary.max_battery_soc_pct:.1f}%")
    print(f"Thermal Survival Heaters Energy: {summary.survival_heaters_energy_wh:.1f} Wh")

    print("\n2. DIRECT-TO-EARTH (DTE) COMMUNICATIONS")
    print("------------------------------------------------------------------------------")
    print(f"Total DTE Contact Time: {summary.total_dte_contact_hours:.2f} hours")
    print(f"Total Radio Blackout Time: {summary.total_blackout_hours:.2f} hours")
    print(f"DTE Link Availability: {summary.dte_availability_pct:.2f}%")
    print(f"Detected Communication Passes: {len(comm_windows)}")

    # Display first 4 communication passes
    # Mostrar los primeros 4 pases de comunicacion
    print("\n3. SCHEDULED TIMELINE WINDOWS")
    print("------------------------------------------------------------------------------")
    for w in comm_windows[:5]:
        print(f"Window #{w.window_id} [{w.window_type}]: {w.start_utc} -> {w.end_utc} ({w.duration_hours:.2f} h) Earth Max: {w.max_earth_elevation_deg:.2f}°")

    # Export to JSON for Dashboard and API
    # Exportar a JSON para Dashboard y API
    export_payload = {
        "site_id": "site_01",
        "site_name": "Connecting Ridge (Shackleton Rim)",
        "summary": {
            "total_simulation_hours": summary.total_simulation_hours,
            "fixed_panel_energy_wh": summary.fixed_panel_energy_wh,
            "tracking_panel_energy_wh": summary.tracking_panel_energy_wh,
            "gain_ratio": summary.tracking_efficiency_gain_ratio,
            "min_battery_soc_pct": summary.min_battery_soc_pct,
            "max_battery_soc_pct": summary.max_battery_soc_pct,
            "dte_availability_pct": summary.dte_availability_pct,
        },
        "communication_windows": [w.__dict__ for w in comm_windows],
        "hardware_integration": {
            "solar_panel_pin": "GPIO 1 (ADC1 - Voltage Sensing)",
            "dht22_pin": "GPIO 4 (Payload Temperature & Humidity)",
            "teleoperation_arm": "5-DOF Servo Joint Control (<100ms WebSocket)",
            "sun_tracking_mode": "ACTIVE_SOLAR_ARRAY_DRIVE",
        },
        "sample_trajectory": [
            {
                "timestamp": str(idx),
                "sun_elev": float(row["sun_elevation_deg"]),
                "sun_az": float(row["sun_azimuth_deg"]),
                "sun_visible": bool(row["sun_visible_true"]),
                "earth_az": float(row["earth_azimuth_deg"]),
                "earth_elev": float(row["earth_elevation_deg"]),
                "heaters_active": bool(row["heaters_active"]),
                "power_tracking_w": float(row["power_tracking_watts"]),
                "power_fixed_w": float(row["power_fixed_watts"]),
                "battery_soc_pct": float(row["battery_soc_pct"]),
                "battery_temp_c": float(row["simulated_battery_temp_c"]),
                "dte_visible": bool(row["earth_visible_true"]) if "earth_visible_true" in row else False,
            }
            for idx, row in sim_df.iloc[::4].iterrows()  # 1-hour interval sampling
        ],
    }

    out_file = processed_dir / "mission_timeline_simulation.json"
    with open(out_file, "w") as f:
        json.dump(export_payload, f, indent=2)

    print(f"\n[PASS] Saved mission simulation to: {out_file.name}")
    print(f"Simulation completed in: {t_end - t0:.3f} s")
    print("Ready to conclude Phase 3.")


def main():
    run_mission_simulation()


if __name__ == "__main__":
    main()
