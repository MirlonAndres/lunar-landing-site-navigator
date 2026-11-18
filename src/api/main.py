"""
High-Frequency Asynchronous REST API and Real-Time Teleoperation WebSocket Server
Servidor de API REST Asincrona de Alta Frecuencia y WebSocket de Teleoperacion
NASA Space Apps Challenge 2026 - Lunar Landing Site Navigator

English:
Provides mission control services:
1. REST endpoints for multi-site Artemis portfolio, 3D terrain meshes, landing safety scores,
   and solar power generation / DTE communication timelines.
2. Low-latency bidirectional WebSocket relay (<100ms) for ESP32-S3 robotic arm actuator,
   physical DHT22 environmental sensor, and solar panel voltage telemetry.
3. Dual-mode support for local direct network and hackathon Google Cloud broker.

Espanol:
Proporciona servicios de control de mision:
1. Puntos de enlace REST para el portafolio multi-sitio Artemis, mallas 3D de terreno, puntajes
   de seguridad de alunizaje y cronogramas de potencia solar / telecomunicaciones DTE.
2. Retransmision WebSocket bidireccional de baja latencia (<100ms) para el brazo robotico ESP32-S3,
   sensor ambiental fisico DHT22 y telemetria de voltaje de panel solar.
3. Soporte de modo dual para red local directa y broker en la nube Google Cloud de la hackathon.
"""

import json
import time
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, Any, List, Optional, Set
import pandas as pd

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, RedirectResponse, PlainTextResponse
from pydantic import BaseModel, Field

from src.api.cloud_relay import HackathonCloudBridge, map_device_fields

# Root paths
# Rutas raiz del repositorio
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_PROCESSED_DIR = REPO_ROOT / "data" / "processed"
DASHBOARD_DIR = REPO_ROOT / "src" / "dashboard"


# ==============================================================================
# 1. PYDANTIC DATA SCHEMAS / ESQUEMAS DE DATOS PYDANTIC
# ==============================================================================

class TelemetryPayload(BaseModel):
    """
    English: Real-time telemetry payload from ESP32-S3 robotic arm and physical sensors.
    Espanol: Paquete de telemetria en tiempo real desde el brazo robotico ESP32-S3 y sensores fisicos.
    """
    device: str = Field(default="esp32_s3_arm", description="Device identifier / Identificador del dispositivo")
    timestamp: float = Field(default_factory=time.time, description="Epoch timestamp / Marca de tiempo")
    angles: List[float] = Field(default=[90.0, 55.0, 60.0, 70.0, 90.0], description="5-DOF servo joint angles / Angulos de 5 ejes")
    dht22_temp_c: Optional[float] = Field(default=22.5, description="Physical DHT22 temperature in Celsius / Temp fisica DHT22 en °C")
    dht22_humidity_pct: Optional[float] = Field(default=45.0, description="Physical DHT22 humidity percentage / Humedad fisica DHT22 en %")
    solar_voltage_v: Optional[float] = Field(default=2.15, description="Solar panel ADC voltage / Voltaje ADC del panel solar")
    battery_soc_pct: Optional[float] = Field(default=95.0, description="Battery state of charge / Estado de carga de bateria")
    mode: str = Field(default="SUN_TRACKING_MODE", description="Operating mode / Modo operativo")
    link_latency_ms: Optional[float] = Field(default=12.5, description="Round-trip latency / Latencia de ida y vuelta")


class ArmCommand(BaseModel):
    """
    English: Actuator positioning command sent to ESP32-S3 arm.
    Espanol: Comando de posicionamiento de actuador enviado al brazo ESP32-S3.
    """
    target_angles: List[float] = Field(description="5 servo angles in degrees [0 to 180]")
    mode: Optional[str] = Field(default="MANUAL_TELEOP", description="Control mode / Modo de control")
    speed_factor: Optional[float] = Field(default=1.0, description="Motion speed multiplier")


# ==============================================================================
# 2. STATE AND WEBSOCKET CONNECTION MANAGER / GESTOR DE ESTADO Y CONEXIONES WS
# ==============================================================================

class TeleopRelayManager:
    """
    English: Thread-safe connection broker managing WebSocket dashboards and hardware nodes.
    Espanol: Gestor de conexiones seguro que administra paneles web y nodos de hardware.
    """

    def __init__(self):
        self.active_dashboards: Set[WebSocket] = set()
        self.active_hardware: Set[WebSocket] = set()
        self.last_local_packet_time = 0.0
        # No fabricated defaults: None until a real sensor reports.
        # Sin valores inventados: None hasta que un sensor real reporte.
        self.latest_telemetry: Dict[str, Any] = {
            "device": "esp32_s3_arm",
            "timestamp": time.time(),
            "angles": [90.0, 55.0, 60.0, 70.0, 90.0],
            "dht22_temp_c": None,
            "dht22_humidity_pct": None,
            "solar_voltage_v": None,
            "battery_soc_pct": None,
            "mode": "MANUAL",
            "source": None,
        }

    async def connect_client(self, websocket: WebSocket, client_type: str = "dashboard"):
        await websocket.accept()
        if client_type == "hardware":
            self.active_hardware.add(websocket)
        else:
            self.active_dashboards.add(websocket)
            # Send latest state immediately upon connection
            await websocket.send_text(json.dumps({
                "type": "state_snapshot",
                "telemetry": self.latest_telemetry,
                "link": link_status(),
            }))

    def disconnect_client(self, websocket: WebSocket):
        self.active_dashboards.discard(websocket)
        self.active_hardware.discard(websocket)

    async def _send_all(self, payload_str: str):
        to_remove = set()
        for ws in list(self.active_dashboards):
            try:
                await ws.send_text(payload_str)
            except Exception:
                to_remove.add(ws)
        for ws in to_remove:
            self.active_dashboards.discard(ws)

    async def broadcast_telemetry(self, telemetry: Dict[str, Any]):
        self.latest_telemetry.update(telemetry)
        self.latest_telemetry["timestamp"] = time.time()
        await self._send_all(json.dumps({"type": "telemetry_stream", "data": self.latest_telemetry}))

    async def broadcast_link_status(self):
        await self._send_all(json.dumps({"type": "link_status", "data": link_status()}))

    async def dispatch_command_to_hardware(self, angles: List[float], mode: str):
        """
        English: Route an arm command to LAN hardware nodes AND the cloud broker.
        Espanol: Enruta un comando del brazo a nodos LAN Y al broker en la nube.
        """
        payload_str = json.dumps({"t": "cmd", "k": "arm", "v": {"a": [int(round(a)) for a in angles], "m": mode}})
        to_remove = set()
        for ws in list(self.active_hardware):
            try:
                await ws.send_text(payload_str)
            except Exception:
                to_remove.add(ws)
        for ws in to_remove:
            self.active_hardware.discard(ws)
        await cloud_bridge.dispatch_arm_command(angles, mode)
        self.latest_telemetry["commanded_angles"] = [float(a) for a in angles]


relay_manager = TeleopRelayManager()
cloud_bridge = HackathonCloudBridge(relay_manager)

TELEMETRY_STALE_SEC = 10.0


def link_status() -> Dict[str, Any]:
    """
    English: Real ESP32 link status (not the browser link). Data older than 10 s is stale.
    Espanol: Estado real del enlace con el ESP32 (no del navegador). Datos de mas de 10 s caducan.
    """
    now = time.time()
    last = max(cloud_bridge.last_cloud_packet_time, relay_manager.last_local_packet_time)
    age = (now - last) if last > 0 else None
    fresh = age is not None and age <= TELEMETRY_STALE_SEC
    local = len(relay_manager.active_hardware) > 0
    online = local or cloud_bridge.device_online
    if online and fresh:
        state = "ONLINE"
    elif online:
        state = "NO_DATA"
    else:
        state = "OFFLINE"
    return {
        "esp32_state": state,
        "esp32_online": online,
        "data_fresh": fresh,
        "last_packet_age_s": round(age, 1) if age is not None else None,
        "path": "LAN" if local else ("CLOUD" if cloud_bridge.device_online else None),
        "cloud_connected": cloud_bridge.is_connected,
        "rssi_dbm": cloud_bridge.device_rssi,
        "cmd_latency_ms": cloud_bridge.last_cmd_latency_ms,
    }


async def link_status_loop():
    while True:
        await asyncio.sleep(2.0)
        try:
            await relay_manager.broadcast_link_status()
        except Exception:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    English: Lifecycle manager spawning background cloud relay bridge and link monitor.
    Espanol: Gestor de ciclo de vida que inicia el puente con la nube y el monitor de enlace.
    """
    bridge_task = asyncio.create_task(cloud_bridge.start())
    status_task = asyncio.create_task(link_status_loop())
    yield
    cloud_bridge.stop()
    bridge_task.cancel()
    status_task.cancel()


# ==============================================================================
# 3. FASTAPI APP AND MIDDLEWARE SETUP / CONFIGURACION DE FASTAPI Y MIDDLEWARE
# ==============================================================================

app = FastAPI(
    title="Lunar Landing Site Navigator - Teleoperation & Mission Control API",
    description="High-frequency REST and WebSocket server for lunar landing site evaluation and ESP32-S3 robotic arm telemetry.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def disable_dashboard_cache(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/dashboard") or request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


# ==============================================================================
# 4. REST API ENDPOINTS / PUNTOS DE ENLACE DE LA API REST
# ==============================================================================

@app.get("/api/health")
async def get_health():
    """
    English: System health, uptime, and active connection metrics.
    Espanol: Estado de salud del sistema, tiempo activo y conexiones activas.
    """
    return {
        "status": "OPERATIONAL",
        "system": "Lunar Landing Site Navigator",
        "mission": "NASA Space Apps Challenge 2026",
        "active_dashboards": len(relay_manager.active_dashboards),
        "active_hardware_nodes": len(relay_manager.active_hardware),
        "esp32_link": link_status(),
        "cloud_bridge_connected": cloud_bridge.is_connected,
        "team_id": "eq01",
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


@app.get("/api/portfolio/sites")
async def get_artemis_portfolio():
    """
    English: Returns comparative multi-criteria evaluation of all 4 candidate Artemis landing sites.
    Espanol: Retorna la evaluacion comparativa multicriterio de los 4 sitios candidatos de Artemis.
    """
    parquet_path = DATA_PROCESSED_DIR / "artemis_sites_planetary_synthesis.parquet"
    if not parquet_path.exists():
        raise HTTPException(status_code=404, detail="Planetary synthesis dataset not found")

    df = pd.read_parquet(parquet_path)
    return {
        "count": len(df),
        "sites": df.to_dict(orient="records"),
    }


@app.get("/api/terrain/metrics")
async def get_terrain_metrics():
    """
    English: Returns summary of digital elevation model geomorphometry (elevations, slopes, roughness, hazards).
    Espanol: Retorna el resumen de geomorfometria del modelo digital de elevacion.
    """
    summary_path = DATA_PROCESSED_DIR / "terrain_metrics_summary.json"
    if not summary_path.exists():
        raise HTTPException(status_code=404, detail="Terrain metrics summary not found")

    with open(summary_path, "r") as f:
        data = json.load(f)
    return data


@app.get("/api/terrain/mesh")
async def get_terrain_3d_mesh():
    """
    English: Returns downsampled 256x256 heightmap and slope matrix for 3D Three.js WebGL rendering.
    Espanol: Retorna la malla reducida de 256x256 de alturas y pendientes para renderizado 3D en Three.js.
    """
    mesh_path = DATA_PROCESSED_DIR / "terrain_3d_mesh.json"
    if not mesh_path.exists():
        raise HTTPException(status_code=404, detail="3D terrain mesh dataset not found")

    with open(mesh_path, "r") as f:
        data = json.load(f)
    return data


@app.get("/api/landing-zones")
async def get_optimal_landing_zones():
    """
    English: Returns top 5 optimal circular landing footprints on Connecting Ridge.
    Espanol: Retorna las 5 mejores zonas de alunizaje circulares en Connecting Ridge.
    """
    sites_path = DATA_PROCESSED_DIR / "optimal_landing_sites.json"
    if not sites_path.exists():
        raise HTTPException(status_code=404, detail="Optimal landing sites dataset not found")

    with open(sites_path, "r") as f:
        data = json.load(f)
    return {
        "target_region": "Connecting Ridge (Shackleton Rim)",
        "optimal_footprints": data,
    }


@app.get("/api/mission/timeline")
async def get_mission_timeline():
    """
    English: Returns 7-day power generation profile, battery SoC, DTE contact passes, and blackout windows.
    Espanol: Retorna el perfil de 7 dias de generacion electrica, SoC de bateria y pases de contacto DTE.
    """
    timeline_path = DATA_PROCESSED_DIR / "mission_timeline_simulation.json"
    if not timeline_path.exists():
        raise HTTPException(status_code=404, detail="Mission timeline simulation dataset not found")

    with open(timeline_path, "r") as f:
        data = json.load(f)
    return data


@app.get("/api/telemetry/latest")
async def get_latest_telemetry():
    """
    English: Returns snapshot of latest physical and simulated telemetry.
    Espanol: Retorna la instantanea mas reciente de telemetria fisica y simulada.
    """
    return {**relay_manager.latest_telemetry, "link": link_status()}


@app.get("/api/terrain/illumination")
async def get_terrain_illumination():
    """
    English: Returns ray-cast mission illumination fraction and PSR cold-trap mask (256x256).
    Espanol: Retorna la fraccion de iluminacion por trazado de rayos y la mascara PSR (256x256).
    """
    path = DATA_PROCESSED_DIR / "terrain_illumination.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Illumination map not found. Run scripts/compute_illumination_map.py")
    with open(path, "r") as f:
        return json.load(f)


@app.get("/api/mission/report")
async def get_mission_report(format: str = Query("json", description="Output format: 'json' or 'markdown'")):
    """
    English: Generates a comprehensive aerospace mission evaluation report with MCDA rankings,
    safe touchdown zones, 7-day power generation balance, and IoT hardware telemetry.
    Espanol: Genera un reporte exhaustivo de evaluacion de mision aeroespacial con clasificacion
    MCDA, zonas seguras de alunizaje, balance energetico de 7 dias y telemetria IoT.
    """
    sites_path = DATA_PROCESSED_DIR / "artemis_sites_planetary_synthesis.parquet"
    zones_path = DATA_PROCESSED_DIR / "optimal_landing_sites.json"
    tl_path = DATA_PROCESSED_DIR / "mission_timeline_simulation.json"

    sites_data = []
    if sites_path.exists():
        df = pd.read_parquet(sites_path)
        sites_data = df.to_dict(orient="records")

    zones_data = []
    if zones_path.exists():
        with open(zones_path, "r") as f:
            zones_data = json.load(f)

    tl_data = {}
    if tl_path.exists():
        with open(tl_path, "r") as f:
            tl_data = json.load(f)

    report = {
        "mission_title": "Lunar Landing Site Navigator - Artemis South Polar Evaluation",
        "team_id": "eq01",
        "event": "NASA International Space Apps Challenge 2026",
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "summary": {
            "primary_selected_site": "Connecting Ridge (Shackleton Rim)",
            "prime_touchdown_zone": "Zona segura #1 (Elev. +1304 m, Pendiente 2.73°, Score 92.7)",
            "energy_gain_vs_fixed_panel": "50.1x (15,795 Wh vs 315 Wh)",
            "battery_safety_margin": "23.8% minimum SoC during polar eclipse",
            "hardware_in_the_loop_status": link_status(),
        },
        "candidate_sites_mcda": sites_data,
        "optimal_landing_zones": zones_data,
        "energy_and_telecom_profile": {
            "duration_hours": tl_data.get("mission_duration_hours", 168),
            "total_tracking_energy_wh": tl_data.get("total_tracking_energy_wh", 15795.0),
            "total_fixed_energy_wh": tl_data.get("total_fixed_energy_wh", 315.0),
            "energy_multiplier": tl_data.get("energy_multiplier", 50.1),
            "battery_capacity_wh": tl_data.get("battery_capacity_wh", 5000.0),
            "min_battery_soc_pct": tl_data.get("min_battery_soc_pct", 23.8),
            "dte_contact_fraction": tl_data.get("dte_contact_fraction", 0.65),
        },
    }

    if format.lower() == "markdown":
        md_lines = [
            "# LUNAR LANDING SITE NAVIGATOR — MISSION DECISION REPORT",
            "**NASA International Space Apps Challenge 2026 | Equipo 01 (`eq01`)**",
            f"*Generated: {report['generated_at_utc']}*\n",
            "## 1. Executive Summary",
            f"- **Primary Site Chosen**: {report['summary']['primary_selected_site']}",
            f"- **Prime Touchdown Zone**: {report['summary']['prime_touchdown_zone']}",
            f"- **Solar Tracking Energy Multiplier**: {report['summary']['energy_gain_vs_fixed_panel']}",
            f"- **Battery Survival Margin**: {report['summary']['battery_safety_margin']}",
            f"- **Hardware Cloud Link**: {report['summary']['hardware_in_the_loop_status']['esp32_state']} (Cloud Connected: {report['summary']['hardware_in_the_loop_status']['cloud_connected']})\n",
            "## 2. Artemis Candidate Sites MCDA Evaluation",
            "| Rank | Site Name | Elev (m) | Slope (°) | Sun (%) | DTE (%) | Score / 100 |",
            "|------|-----------|----------|-----------|---------|---------|-------------|",
        ]
        for idx, s in enumerate(sites_data):
            name = s.get("name_es", s.get("name_en", "Site"))
            md_lines.append(
                f"| {idx + 1} | {name} | {s.get('elevation_m', 0):.0f} | {s.get('mean_slope_deg', 0):.1f} | "
                f"{s.get('sun_illumination_pct', 0):.1f} | {s.get('earth_dte_pct', 0):.1f} | "
                f"{s.get('landing_suitability_score', 0):.1f} |"
            )

        md_lines.extend([
            "\n## 3. Top 5 Safe Touchdown Zones (Connecting Ridge)",
            "| Rank | Ground Elevation | Max Slope | Roughness | PSR Dist | Safety Score |",
            "|------|------------------|-----------|-----------|----------|--------------|",
        ])
        for z in zones_data:
            md_lines.append(
                f"| #{z.get('rank')} | +{z.get('elevation_m', 0):.0f} m | {z.get('max_slope_deg', 0):.1f}° | "
                f"{z.get('mean_roughness_m', 0):.3f} m | {z.get('proximity_to_psr_km', 0):.2f} km | "
                f"**{z.get('composite_safety_score', 0):.1f}** |"
            )

        md_lines.extend([
            "\n## 4. 7-Day Polar Solar Energy & Telecom Synthesis",
            f"- **Active 5-DOF Solar Tracking**: {report['energy_and_telecom_profile']['total_tracking_energy_wh']:,.0f} Wh",
            f"- **Fixed Horizontal Panel**: {report['energy_and_telecom_profile']['total_fixed_energy_wh']:,.0f} Wh",
            f"- **Net Gain Multiplier**: x{report['energy_and_telecom_profile']['energy_multiplier']:.1f}",
            f"- **Direct-To-Earth (DTE) Contact Time**: {report['energy_and_telecom_profile']['dte_contact_fraction']*100:.1f}%",
            f"- **Survival Battery Pack**: 5,000 Wh (Low-power hibernation during shadow, minimum SoC {report['energy_and_telecom_profile']['min_battery_soc_pct']}%)",
        ])
        return PlainTextResponse("\n".join(md_lines), media_type="text/markdown")

    return report


# ==============================================================================
# 5. WEBSOCKET REAL-TIME ENDPOINTS / PUNTOS DE ENLACE WEBSOCKET EN TIEMPO REAL
# ==============================================================================

@app.websocket("/ws/teleop")
async def websocket_teleop_endpoint(websocket: WebSocket, client_type: str = "dashboard"):
    """
    English: Bidirectional real-time WebSocket channel for dashboards and ESP32-S3 hardware.
    Espanol: Canal WebSocket bidireccional en tiempo real para paneles web y hardware ESP32-S3.
    """
    await relay_manager.connect_client(websocket, client_type=client_type)
    try:
        while True:
            text_data = await websocket.receive_text()
            try:
                msg = json.loads(text_data)
                msg_type = msg.get("type", "") or msg.get("t", "")

                # Inbound telemetry from LAN ESP32 hardware (same schema as cloud: "d")
                # Telemetria entrante desde ESP32 por LAN (mismo esquema que la nube: "d")
                if msg_type in ("telemetry", "tel"):
                    raw = msg.get("d") or msg.get("data") or {}
                    relay_manager.last_local_packet_time = time.time()
                    mapped = map_device_fields(raw)
                    mapped["source"] = "LAN"
                    await relay_manager.broadcast_telemetry(mapped)

                # Outbound arm command from web dashboard -> LAN + cloud broker
                # Comando del brazo desde el panel -> LAN + broker en la nube
                elif msg_type in ("command", "cmd"):
                    angles = msg.get("target_angles") or (msg.get("v") or {}).get("a")
                    if isinstance(angles, list) and len(angles) == 5:
                        joint_limits = [(0.0, 180.0), (0.0, 180.0), (20.0, 160.0), (0.0, 180.0), (0.0, 180.0)]
                        safe = [max(lo, min(hi, float(a))) for a, (lo, hi) in zip(angles, joint_limits)]
                        await relay_manager.dispatch_command_to_hardware(safe, str(msg.get("mode", "MANUAL")))

                # Ping / Keep-alive latency measurement
                # Medicion de latencia y ping
                elif msg_type == "ping":
                    await websocket.send_text(json.dumps({
                        "type": "pong",
                        "server_time": time.time(),
                        "echo": msg.get("echo", 0),
                    }))

            except json.JSONDecodeError:
                pass

    except WebSocketDisconnect:
        relay_manager.disconnect_client(websocket)
    except Exception:
        relay_manager.disconnect_client(websocket)


# Mount dashboard static directory if present
if DASHBOARD_DIR.is_dir():
    app.mount("/dashboard", StaticFiles(directory=str(DASHBOARD_DIR), html=True), name="dashboard")


@app.get("/", response_class=HTMLResponse)
async def root_redirect():
    """
    English: Root route redirecting to dashboard.
    Espanol: Ruta raiz que redirige al panel de control.
    """
    return """
    <!DOCTYPE html>
    <html>
      <head>
        <title>Lunar Landing Site Navigator</title>
        <meta http-equiv="refresh" content="0; url=/dashboard" />
        <style>body{background:#0a0e17;color:#e2e8f0;font-family:sans-serif;padding:2rem;text-align:center;}</style>
      </head>
      <body>
        <h2>Lunar Landing Site Navigator - NASA Space Apps Challenge 2026</h2>
        <p>Redirecting to <a href="/dashboard" style="color:#38bdf8;">/dashboard</a>...</p>
      </body>
    </html>
    """
