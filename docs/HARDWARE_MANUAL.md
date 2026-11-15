# Hardware Specification & Teleoperation Manual

This manual details the electrical architecture, micro-controller configuration, servo calibration, and communications protocol for the **Lunar Landing Site Navigator 5-DOF Robotic Arm**.

---

## 1. System Overview & Component Bill of Materials (BOM)

| Component | Specification | Function / Description |
|---|---|---|
| **Microcontroller** | ESP32-S3 (WROOM-1 / DevKit-C), Dual Core Xtensa LX7 @ 240MHz, 16MB Flash, 8MB PSRAM | Core 0: FreeRTOS TLS WebSocket; Core 1: I2C sensor bus & telemetry |
| **PWM Servo Driver** | PCA9685 16-Channel 12-Bit I2C PWM Controller (`0x40`) | Offloads 50 Hz PWM generation from MCU to guarantee jitter-free motion |
| **Actuators (5x)** | MG996R / MG90S High-Torque Metal Gear Servos | 5-DOF articulation (Base, Shoulder, Elbow, Wrist, End-Effector Roll) |
| **PV Sensor Panel** | Mini Solar Cell + Voltage Divider (100kΩ / 10kΩ) | Measures live solar harvesting efficiency on end-effector |
| **Telemetry Sensor** | DHT22 / AM2302 (Optional) | Environmental temperature and relative humidity monitoring |
| **Power Supply** | Dual Rail: 5V/3A DC (Servos) + 5V/1A USB-C (ESP32 Logic) | Common ground isolation prevents servo inductive kickback resets |

---

## 2. Wiring & Pinout Reference

```
  +--------------------------------------------------------------+
  |                     ESP32-S3 Microcontroller                 |
  |                                                              |
  |   [3V3]  [GND]    [GPIO 8 (SDA)]    [GPIO 9 (SCL)]   [GPIO 1]|
  +-----|------|-------------|-----------------|------------|----+
        |      |             |                 |            |
        |      |             |                 |            +--- PV Sensor ADC
        |      |             |                 |                 (0-3.3V Divider)
        |      |             |                 |
  +-----|------|-------------|-----------------|-----------------+
  |    VCC    GND           SDA               SCL                |
  |                     PCA9685 I2C Board                        |
  |  [V+] Servo Power Rail (External 5V / 3A DC Supply)         |
  +--------------------------------------------------------------+
       |       |       |       |       |
      CH0     CH1     CH2     CH3     CH4
       |       |       |       |       |
     Base   Shoulder Elbow   Wrist   Roll
     Servo   Servo   Servo   Servo   Servo
```

### Pin Mapping Table
| ESP32-S3 Pin | PCA9685 Pin | Function | Notes |
|---|---|---|---|
| **GPIO 8** | SDA | I2C Serial Data | Hardware I2C bus @ 100 kHz |
| **GPIO 9** | SCL | I2C Serial Clock | Hardware I2C bus @ 100 kHz |
| **GPIO 1** | — | Analog Solar Voltage | 16× oversampled 12-bit ADC |
| **GPIO 4** | — | DHT22 Data | Environmental temperature / humidity |
| **3V3** | VCC | Logic Power | Powers PCA9685 logic IC only |
| **GND** | GND | Common Ground | **MUST connect MCU GND to external 5V GND** |
| **Ext 5V** | V+ | Servo Power Rail | Independent 5V 3A+ DC power adapter |

---

## 3. PCA9685 Servo Channel Map & Mechanical Limits

To protect the 3D-printed joints and prevent mechanical binding, all motion is strictly clamped to the following safe anatomical ranges:

| Channel | Joint Name | Physical Motion | Safe Angle Range | Home Position | PCA9685 Pulse Range (12-bit) |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **CH 0** | **Base Turntable** | Azimuth Yaw ($\psi$) | $25^\circ \dots 155^\circ$ | $90^\circ$ | $145 \dots 455$ ticks ($700 \dots 2200\,\mu\text{s}$) |
| **CH 1** | **Shoulder** | Elevation Pitch ($\theta_1$) | $35^\circ \dots 115^\circ$ | $55^\circ$ | $165 \dots 370$ ticks ($800 \dots 1800\,\mu\text{s}$) |
| **CH 2** | **Elbow** | Flexion Pitch ($\theta_2$) | $40^\circ \dots 125^\circ$ | $60^\circ$ | $175 \dots 390$ ticks ($850 \dots 1900\,\mu\text{s}$) |
| **CH 3** | **Wrist** | End-Effector Pitch ($\theta_3$) | $40^\circ \dots 135^\circ$ | $70^\circ$ | $175 \dots 410$ ticks ($850 \dots 2000\,\mu\text{s}$) |
| **CH 4** | **Panel Roll** | Photovoltaic Roll ($\phi$) | $30^\circ \dots 150^\circ$ | $90^\circ$ | $155 \dots 445$ ticks ($750 \dots 2150\,\mu\text{s}$) |

---

## 4. Firmware Architecture & Build Instructions

The firmware is located in `firmware/esp32_s3_arm/esp32_s3_arm.ino`.

### Prerequisites
- [Arduino CLI](https://arduino.github.io/arduino-cli/) or Arduino IDE 2.x
- ESP32 Board Core (v2.0.14+ or v3.0+)
- Required Libraries:
  - `Adafruit-PWM-Servo-Driver-Library`
  - `WebSockets` (by Markus Sattler)
  - `ArduinoJson` (v6.x or v7.x)

### Compilation & Flashing via Arduino CLI
```bash
# Navigate to firmware directory
cd firmware/esp32_s3_arm

# Compile with proper ESP32-S3 USB CDC flags
arduino-cli compile --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc,USBMode=hwcdc,FlashMode=dio,PSRAM=disabled esp32_s3_arm.ino

# Upload to connected COM port (e.g., COM6 on Windows or /dev/ttyACM0 on Linux)
arduino-cli upload -p COM6 --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc,USBMode=hwcdc,FlashMode=dio,PSRAM=disabled esp32_s3_arm.ino
```

> [!NOTE]
> The build configuration uses `CDCOnBoot=cdc` and `USBMode=hwcdc` to ensure seamless serial debugging over the native USB-C port of the ESP32-S3.

---

## 5. Telemetry & Control Payload Schema

### Web-to-Arm Command (JSON)
Transmitted from Mission Control Dashboard to ESP32:
```json
{
  "action": "move_arm",
  "angles": {
    "j0": 90,
    "j1": 55,
    "j2": 60,
    "j3": 70,
    "j4": 90
  },
  "mode": "track_sun"
}
```

### Arm-to-Cloud Telemetry (JSON)
Streamed every 200 ms from ESP32 to Mission Control:
```json
{
  "team_id": "eq01",
  "status": "ONLINE",
  "rssi": -58,
  "uptime_s": 1420,
  "joints": {
    "j0": 89.8,
    "j1": 55.1,
    "j2": 59.9,
    "j3": 70.0,
    "j4": 90.2
  },
  "sensors": {
    "solar_v": 2.84,
    "efficiency_pct": 98.4,
    "temp_c": -18.2,
    "current_ma": 42.1
  }
}
```
