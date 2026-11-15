"""
Hackathon Official Google Cloud Run Broker Relay Bridge
Puente de Retransmision con el Broker Oficial de Google Cloud de la Hackathon
NASA Space Apps Challenge 2026 - Lunar Landing Site Navigator

Maintains an asynchronous client connection to the official hackathon cloud broker
(fimee-esp32-hub on Google Cloud Run - Santiago) for Equipo 01 ('eq01').
Protocol (official guide, section 5):
  web -> broker : {"t":"auth","token":WEB_KEY,"equipos":["eq01"]}
  broker -> web : "auth_ok" | "estado"/"presencia" (online flag) | "tel" (sensor data "d") | "ack"
  web -> broker : {"t":"cmd","id":"eq01","cid":...,"k":"arm","v":{"a":[5 angles],"m":mode}}
Unified telemetry schema inside "d": solar_v, temp, hum, angles, bat.

"""

import asyncio
import json
import logging
import os
import time
from typing import Optional, Dict, Any

import websockets

logger = logging.getLogger("cloud_relay")

# Cloud IoT Broker Credentials (Configurable via Environment Variables)
# Credenciales del Broker IoT (Configurables mediante Variables de Entorno)
CLOUD_WS_URL = os.getenv("HACKATHON_CLOUD_WS_URL", "wss://fimee-esp32-hub-ahife23fha-tl.a.run.app/ws")
EQUIPO_ID = os.getenv("HACKATHON_EQUIPO_ID", "eq01")
WEB_KEY = os.getenv("HACKATHON_WEB_KEY", "YOUR_WEB_KEY_HERE")


def map_device_fields(d: Dict[str, Any]) -> Dict[str, Any]:
    """
    """
    out: Dict[str, Any] = {}

    def num(*keys):
        for k in keys:
            if k in d and d[k] is not None:
                try:
                    return float(d[k])
                except (TypeError, ValueError):
                    return None
        return None

    temp = num("temp", "dht22_temp_c")
    hum = num("hum", "humedad", "dht22_humidity_pct")
    volt = num("solar_v", "volt", "solar_voltage_v")
    bat = num("bat", "battery_soc_pct")
    if temp is not None:
        out["dht22_temp_c"] = temp
    if hum is not None:
        out["dht22_humidity_pct"] = hum
    if volt is not None:
        out["solar_voltage_v"] = volt
    if bat is not None:
        out["battery_soc_pct"] = bat
    angles = d.get("angles")
    if isinstance(angles, list) and len(angles) == 5:
        out["angles"] = [float(a) for a in angles]
    if "mode" in d:
        out["mode"] = str(d["mode"])
    if "acc" in d:
        out["accelerometer"] = d["acc"]
    return out


class HackathonCloudBridge:
    """
    """

    def __init__(self, relay_manager):
        self.relay_manager = relay_manager
        self.is_running = False
        self.is_connected = False          # Server <-> broker link / Enlace servidor <-> broker
        self.is_authenticated = False
        self.device_online = False         # ESP32 presence reported by broker / Presencia del ESP32
        self.device_rssi: Optional[int] = None
        self.ws_client = None
        self.last_cloud_packet_time = 0.0
        self.last_cmd_latency_ms: Optional[float] = None
        self._pending_cmds: Dict[str, float] = {}

    async def start(self):
        """
        """
        self.is_running = True
        logger.info(f"Starting Hackathon Cloud Bridge for team {EQUIPO_ID}...")

        while self.is_running:
            try:
                async with websockets.connect(
                    CLOUD_WS_URL, ping_interval=15, ping_timeout=10, ssl=True
                ) as ws:
                    self.ws_client = ws
                    self.is_connected = True
                    await ws.send(json.dumps({"t": "auth", "token": WEB_KEY, "equipos": [EQUIPO_ID]}))
                    async for raw_message in ws:
                        await self._process_cloud_message(raw_message)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning(f"Cloud bridge interrupted / Conexion interrumpida: {exc}. Reconnecting in 3s...")
            finally:
                self.is_connected = False
                self.is_authenticated = False
                self.ws_client = None
            if self.is_running:
                await asyncio.sleep(3.0)

    async def _process_cloud_message(self, raw_message: str):
        """
        """
        try:
            msg = json.loads(raw_message)
        except json.JSONDecodeError:
            return

        t = msg.get("t", "")
        msg_id = msg.get("id", "")

        if t == "auth_ok":
            self.is_authenticated = True
            logger.info("Cloud authentication OK / Autenticacion en la nube correcta (eq01).")
            return

        if t in ("estado", "presencia") and msg_id == EQUIPO_ID:
            self.device_online = bool(msg.get("online", False))
            if msg.get("rssi") is not None:
                self.device_rssi = msg.get("rssi")
            ultima = msg.get("ultimaTel") or {}
            if self.device_online and ultima.get("d"):
                await self._ingest(ultima["d"])
            return

        if t == "tel" and msg_id == EQUIPO_ID:
            self.device_online = True
            if msg.get("rssi") is not None:
                self.device_rssi = msg.get("rssi")
            await self._ingest(msg.get("d", {}) or {})
            return

        if t == "ack":
            cid = msg.get("cid", "")
            sent = self._pending_cmds.pop(cid, None)
            if sent is not None:
                self.last_cmd_latency_ms = round((time.perf_counter() - sent) * 1000.0, 1)
            return

    async def _ingest(self, d: Dict[str, Any]):
        self.last_cloud_packet_time = time.time()
        mapped = map_device_fields(d)
        mapped["source"] = "CLOUD_BROKER"
        mapped["rssi_dbm"] = self.device_rssi
        await self.relay_manager.broadcast_telemetry(mapped)

    async def dispatch_arm_command(self, angles, mode: str = "MANUAL") -> bool:
        """
        """
        if not self.is_connected or self.ws_client is None:
            return False
        cid = f"c-{int(time.time() * 1000)}"
        self._pending_cmds[cid] = time.perf_counter()
        # Keep pending map bounded / Mantener acotado el mapa de pendientes
        if len(self._pending_cmds) > 64:
            for k in list(self._pending_cmds.keys())[:32]:
                self._pending_cmds.pop(k, None)
        payload = {
            "t": "cmd",
            "id": EQUIPO_ID,
            "cid": cid,
            "k": "arm",
            "v": {"a": [int(round(a)) for a in angles], "m": mode},
        }
        try:
            await self.ws_client.send(json.dumps(payload))
            return True
        except Exception:
            return False

    def stop(self):
        self.is_running = False
