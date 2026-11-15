"""
Mission Power, Articulated Sun-Tracking, and DTE Communication Simulator
Simulador de Potencia de Mision, Seguimiento Solar Articulado y Enlace DTE
NASA Space Apps Challenge 2026 - Lunar Landing Site Navigator

English:
Simulates:
1. Solar photovoltaic generation comparing fixed vs. 5-DOF articulated sun-tracking array.
2. Battery state-of-charge (SoC %) and thermal survival heater loads during eclipses.
3. Direct-to-Earth (DTE) communication visibility passes and radio blackout windows.
4. Telemetry integration schema for physical ESP32-S3 DHT22 and solar ADC sensors.

Espanol:
Simula:
1. Generacion fotovoltaica comparando panel fijo frente a panel articulado con seguimiento solar 5-DOF.
2. Estado de carga de bateria (SoC %) y consumo de calentadores termicos en eclipses.
3. Pases de comunicacion directa a la Tierra (DTE) y ventanas de silencio de radio (blackouts).
4. Esquema de integracion de telemetria fisica para sensores DHT22 y ADC solar del ESP32-S3.
"""

from dataclasses import dataclass, asdict
from typing import List, Dict, Any, Tuple
import numpy as np
import pandas as pd


@dataclass(frozen=True)
class CommunicationWindow:
    """
    English: Direct-to-Earth (DTE) contact pass or radio blackout interval.
    Espanol: Intervalo de pase de contacto directo a la Tierra (DTE) o silencio de radio.
    """
    window_id: int
    window_type: str  # "DTE_CONTACT" or "RADIO_BLACKOUT"
    start_utc: str
    end_utc: str
    duration_hours: float
    mean_earth_elevation_deg: float
    max_earth_elevation_deg: float


@dataclass(frozen=True)
class MissionPowerProfile:
    """
    English: Consolidated summary of simulated mission energy performance.
    Espanol: Resumen consolidado del rendimiento energetico simulado de mision.
    """
    total_simulation_hours: float
    fixed_panel_energy_wh: float
    tracking_panel_energy_wh: float
    tracking_efficiency_gain_ratio: float
    min_battery_soc_pct: float
    max_battery_soc_pct: float
    survival_heaters_energy_wh: float
    total_dte_contact_hours: float
    total_blackout_hours: float
    dte_availability_pct: float


class MissionSimulator:
    """
    English: Core computational engine for solar power, battery thermal loads, and DTE communications.
    Espanol: Motor de calculo central para potencia solar, carga termica de bateria y enlaces DTE.
    """

    def __init__(
        self,
        solar_panel_area_m2: float = 0.50,
        panel_efficiency: float = 0.30,       # Space-grade multi-junction GaAs solar cells (30%)
        battery_capacity_wh: float = 2400.0,  # 2.4 kWh lithium-ion battery pack
        nominal_base_load_w: float = 50.0,    # Core avionics + telemetry
        teleop_arm_load_w: float = 20.0,      # Servo motion load
        survival_heater_load_w: float = 25.0, # Active Kapton thermal heaters in shadow
        hibernation_base_load_w: float = 15.0, # Avionics low-power survival mode / Avionica en modo supervivencia
    ):
        self.hibernation_base_load_w = float(hibernation_base_load_w)
        self.panel_area_m2 = float(solar_panel_area_m2)
        self.panel_efficiency = float(panel_efficiency)
        self.battery_capacity_wh = float(battery_capacity_wh)
        self.nominal_base_load_w = float(nominal_base_load_w)
        self.teleop_arm_load_w = float(teleop_arm_load_w)
        self.survival_heater_load_w = float(survival_heater_load_w)

        # Solar constant at 1 AU: 1361 W/m^2
        self.solar_irradiance_w_m2 = 1361.0

    def simulate_power_and_communications(
        self, ephemeris_df: pd.DataFrame
    ) -> Tuple[pd.DataFrame, MissionPowerProfile, List[CommunicationWindow]]:
        """
        English:
        Run time-series simulation over NASA JPL Horizons ephemerides.
        Computes power generation, battery SoC trajectory, and communication windows.

        Espanol:
        Ejecuta la simulacion temporal sobre las efemerides de NASA JPL Horizons.
        Calcula generacion de potencia, trayectoria de SoC de bateria y ventanas de comunicacion.
        """
        df = ephemeris_df.copy()
        n_steps = len(df)

        if n_steps < 2:
            raise ValueError("Ephemeris DataFrame must contain at least 2 timesteps.")

        dt_hours = (df.index[1] - df.index[0]).total_seconds() / 3600.0

        # Arrays for simulation results
        # Arreglos para resultados de la simulacion
        fixed_power = np.zeros(n_steps, dtype=np.float32)
        tracking_power = np.zeros(n_steps, dtype=np.float32)
        heaters_active = np.zeros(n_steps, dtype=bool)
        total_load = np.zeros(n_steps, dtype=np.float32)
        battery_soc_pct = np.zeros(n_steps, dtype=np.float32)
        simulated_batt_temp_c = np.zeros(n_steps, dtype=np.float32)

        # Initial conditions: 90% battery SoC, +18°C internal temperature
        current_battery_wh = 0.90 * self.battery_capacity_wh
        current_batt_temp_c = 18.0

        for i in range(n_steps):
            sun_elev = float(df["sun_elevation_deg"].iloc[i])
            sun_vis = bool(df["sun_visible_true"].iloc[i]) if "sun_visible_true" in df.columns else (sun_elev > 0)
            illum_frac = float(df["sun_illumination_fraction"].iloc[i]) if "sun_illumination_fraction" in df.columns else (1.0 if sun_vis else 0.0)

            # 1. Power generation
            # Fixed horizontal panel: power is reduced by sin(sun_elevation) -> very low at polar grazing angle
            # Panel horizontal fijo: la potencia se reduce por sin(elevacion) -> muy baja en angulo rasante
            if sun_vis and sun_elev > 0.0:
                sin_elev = max(0.0, np.sin(np.radians(sun_elev)))
                p_fixed = self.panel_area_m2 * self.solar_irradiance_w_m2 * self.panel_efficiency * sin_elev * illum_frac
                # Articulated tracking panel: arm steers panel normal to Sun vector -> optimal normal incidence
                # Panel articulado con seguimiento: el brazo orienta el panel normal al vector solar
                p_tracking = self.panel_area_m2 * self.solar_irradiance_w_m2 * self.panel_efficiency * 0.95 * illum_frac
            else:
                p_fixed = 0.0
                p_tracking = 0.0

            fixed_power[i] = p_fixed
            tracking_power[i] = p_tracking

            # 2. Thermal heaters and total load
            # Calentadores termicos y consumo total
            if not sun_vis:
                heaters_active[i] = True
                p_heater = self.survival_heater_load_w
                current_batt_temp_c = max(5.0, current_batt_temp_c - 0.05)
            else:
                heaters_active[i] = False
                p_heater = 0.0
                current_batt_temp_c = min(22.0, current_batt_temp_c + 0.08)

            # Survival hibernation in shadow: arm parked (0 W) and avionics in low-power mode.
            # Hibernacion de supervivencia en sombra: brazo estacionado (0 W) y avionica en bajo consumo.
            if sun_vis:
                p_load = self.nominal_base_load_w + self.teleop_arm_load_w
            else:
                p_load = self.hibernation_base_load_w + p_heater
            total_load[i] = p_load
            simulated_batt_temp_c[i] = current_batt_temp_c

            # 3. Battery charge/discharge with tracking power
            # Carga y descarga de bateria con potencia de seguimiento
            net_power = p_tracking - p_load
            if net_power >= 0.0:
                # Charging at 95% efficiency
                current_battery_wh = min(self.battery_capacity_wh, current_battery_wh + net_power * dt_hours * 0.95)
            else:
                # Discharging
                current_battery_wh = max(0.0, current_battery_wh + net_power * dt_hours)

            battery_soc_pct[i] = (current_battery_wh / self.battery_capacity_wh) * 100.0

        # Attach to dataframe
        # Incorporar al dataframe
        df["power_fixed_watts"] = fixed_power.round(2)
        df["power_tracking_watts"] = tracking_power.round(2)
        df["total_load_watts"] = total_load.round(2)
        df["battery_soc_pct"] = battery_soc_pct.round(2)
        df["simulated_battery_temp_c"] = simulated_batt_temp_c.round(2)
        df["heaters_active"] = heaters_active

        # 4. Detect DTE communication windows and blackout intervals
        # Detectar ventanas de comunicacion DTE y periodos de silencio
        comm_windows = self._detect_communication_windows(df)

        # 5. Build summary metrics
        # Construir metricas de resumen
        total_hours = n_steps * dt_hours
        tot_fixed_wh = float(np.sum(fixed_power) * dt_hours)
        tot_track_wh = float(np.sum(tracking_power) * dt_hours)
        ratio = tot_track_wh / max(1.0, tot_fixed_wh)

        dte_hours = sum(w.duration_hours for w in comm_windows if w.window_type == "DTE_CONTACT")
        blackout_hours = sum(w.duration_hours for w in comm_windows if w.window_type == "RADIO_BLACKOUT")
        dte_pct = (dte_hours / total_hours) * 100.0 if total_hours > 0 else 0.0

        summary = MissionPowerProfile(
            total_simulation_hours=round(total_hours, 1),
            fixed_panel_energy_wh=round(tot_fixed_wh, 1),
            tracking_panel_energy_wh=round(tot_track_wh, 1),
            tracking_efficiency_gain_ratio=round(ratio, 2),
            min_battery_soc_pct=round(float(np.min(battery_soc_pct)), 2),
            max_battery_soc_pct=round(float(np.max(battery_soc_pct)), 2),
            survival_heaters_energy_wh=round(float(np.sum(heaters_active) * self.survival_heater_load_w * dt_hours), 1),
            total_dte_contact_hours=round(dte_hours, 2),
            total_blackout_hours=round(blackout_hours, 2),
            dte_availability_pct=round(dte_pct, 2),
        )

        return df, summary, comm_windows

    def _detect_communication_windows(self, df: pd.DataFrame) -> List[CommunicationWindow]:
        """
        English: Segment timeline into continuous contact passes and blackout windows.
        Espanol: Segmentar la linea de tiempo en pases de contacto y silencios continuos.
        """
        windows: List[CommunicationWindow] = []
        is_contact_col = "earth_visible_true" if "earth_visible_true" in df.columns else "earth_visible"
        earth_elev_col = "earth_elevation_deg"

        if is_contact_col not in df.columns:
            return windows

        current_state = bool(df[is_contact_col].iloc[0])
        start_idx = 0
        window_counter = 1

        for i in range(1, len(df)):
            state_i = bool(df[is_contact_col].iloc[i])
            if state_i != current_state or i == len(df) - 1:
                end_idx = i if state_i != current_state else i + 1
                segment = df.iloc[start_idx:end_idx]

                duration_h = (segment.index[-1] - segment.index[0]).total_seconds() / 3600.0
                mean_elev = float(segment[earth_elev_col].mean())
                max_elev = float(segment[earth_elev_col].max())

                win = CommunicationWindow(
                    window_id=window_counter,
                    window_type="DTE_CONTACT" if current_state else "RADIO_BLACKOUT",
                    start_utc=str(segment.index[0]),
                    end_utc=str(segment.index[-1]),
                    duration_hours=round(duration_h, 2),
                    mean_earth_elevation_deg=round(mean_elev, 2),
                    max_earth_elevation_deg=round(max_elev, 2),
                )
                windows.append(win)
                window_counter += 1
                start_idx = i
                current_state = state_i

        return windows
