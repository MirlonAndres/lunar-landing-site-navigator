"""
Lunar Landing Site Navigator - Hardware-in-the-Loop ESP32 Cloud Emulator
Emulador de Hardware ESP32 para el Broker en la Nube de la Hackathon
NASA Space Apps Challenge 2026 - Equipo 01 (eq01)

Emulates the physical ESP32-S3 robotic arm connecting to the official Google Cloud Run broker
(fimee-esp32-hub-ahife23fha-tl.a.run.app) using official team credentials.
Allows testing and presenting the "En vivo" (Live) mode and sensor teleoperation without
requiring a physical microcontroller plugged in via USB.

"""

import asyncio
import json
import logging
import math
import os
import sys
import time
import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("esp32_emulator")

# Hackathon IoT Broker Credentials (Configurable via Environment Variables)
CLOUD_WS_URL = os.getenv("HACKATHON_CLOUD_WS_URL", "wss://fimee-esp32-hub-ahife23fha-tl.a.run.app/ws")
EQUIPO_ID = os.getenv("HACKATHON_EQUIPO_ID", "eq01")
DEVICE_TOKEN = os.getenv("HACKATHON_DEVICE_TOKEN", "YOUR_DEVICE_TOKEN_HERE")


class ESP32HardwareEmulator:
    def __init__(self):
        self.angles = [90.0, 45.0, 120.0, 60.0, 30.0]
        self.mode = "AUTO_SUN_TRACK"
        self.running = True

    async def run(self):
        logger.info(f"Connecting to official Google Cloud Run broker at: {CLOUD_WS_URL}")
        logger.info(f"Equipo ID: {EQUIPO_ID} | Device Token: {DEVICE_TOKEN[:4]}****")

        while self.running:
            try:
                async with websockets.connect(
                    CLOUD_WS_URL,
                    ping_interval=20,
                    ping_timeout=10,
                    close_timeout=5,
                ) as ws:
                    logger.info("[OK] Connected to Cloud WebSocket. Sending 'hello' handshake...")
                    hello_msg = {
                        "t": "hello",
                        "id": EQUIPO_ID,
                        "token": DEVICE_TOKEN,
                        "tipo": "esp32",
                        "sensores": ["solar_v", "temp", "hum", "angles", "bat"],
                        "actuadores": ["arm"],
                        "v": "1.0.0",
                    }
                    await ws.send(json.dumps(hello_msg))

                    recv_task = asyncio.create_task(self._receive_loop(ws))
                    send_task = asyncio.create_task(self._telemetry_loop(ws))

                    done, pending = await asyncio.wait(
                        [recv_task, send_task],
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for task in pending:
                        task.cancel()

            except Exception as exc:
                logger.warning(f"Connection lost or failed: {exc}. Reconnecting in 3 seconds...")
                await asyncio.sleep(3)

    async def _receive_loop(self, ws):
        async for raw in ws:
            try:
                msg = json.loads(raw)
                t = msg.get("t")

                if t == "hello_ok":
                    logger.info(f"[BROKER] Handshake confirmed: {msg}")

                elif t == "cmd":
                    cid = msg.get("cid", f"cmd_{int(time.time()*1000)}")
                    actuator = msg.get("k")
                    val = msg.get("v", {})
                    logger.info(f"[CMD RECEIVED] Actuator: {actuator} | Value: {val}")

                    if actuator == "arm" and isinstance(val, dict):
                        new_angles = val.get("a")
                        if isinstance(new_angles, list) and len(new_angles) == 5:
                            self.angles = [float(a) for a in new_angles]
                        if "m" in val:
                            self.mode = str(val["m"])

                    ack_msg = {
                        "t": "ack",
                        "id": EQUIPO_ID,
                        "cid": cid,
                        "ok": True,
                        "a": self.angles,
                    }
                    await ws.send(json.dumps(ack_msg))
                    logger.info(f"[ACK SENT] cid: {cid} | Angles: {self.angles}")

            except Exception as exc:
                logger.error(f"Error handling message: {exc}")

    async def _telemetry_loop(self, ws):
        step = 0
        while True:
            await asyncio.sleep(0.5)  # 2 Hz telemetry
            step += 1

            # Realistic simulated sensor readings
            # Panel solar: ~2.45V to 2.85V with slight analog noise
            noise = (math.sin(step * 0.1) * 0.15) + (math.cos(step * 0.3) * 0.05)
            solar_v = round(max(0.0, min(3.3, 2.65 + noise)), 2)

            # DHT22: Ambient temperature ~22.8C to 23.5C, humidity ~42% to 45%
            temp_c = round(23.2 + math.sin(step * 0.05) * 0.4, 1)
            hum_pct = round(43.5 + math.cos(step * 0.05) * 1.5, 1)

            tel_msg = {
                "t": "tel",
                "id": EQUIPO_ID,
                "d": {
                    "solar_v": solar_v,
                    "temp": temp_c,
                    "hum": hum_pct,
                    "angles": [round(a, 1) for a in self.angles],
                    "mode": self.mode,
                    "bat": 92.0,
                },
            }
            try:
                await ws.send(json.dumps(tel_msg))
                if step % 10 == 0:
                    logger.info(f"[TEL SENT] Solar: {solar_v}V | Temp: {temp_c}C | Hum: {hum_pct}% | Mode: {self.mode}")
            except Exception as exc:
                logger.error(f"Telemetry send error: {exc}")
                break


def main():
    print("==============================================================================")
    print("LUNAR LANDING SITE NAVIGATOR - ESP32 CLOUD HARDWARE EMULATOR")
    print("NASA Space Apps Challenge 2026 - Equipo 01 (eq01)")
    print("==============================================================================\n")
    emulator = ESP32HardwareEmulator()
    try:
        asyncio.run(emulator.run())
    except KeyboardInterrupt:
        print("\nEmulator stopped by user.")


if __name__ == "__main__":
    main()
