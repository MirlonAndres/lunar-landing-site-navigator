# ESP32-S3 Dual-Core Robotic Arm Firmware & Hardware Guide
**NASA International Space Apps Challenge 2026 | Team 01 (`eq01`)**

---

## 1. Hardware Pinout & I2C Bus Configuration

The physical 5-DOF robotic arm uses an **ESP32-S3** microcontroller paired with a **PCA9685 16-channel 12-bit PWM I2C driver** (`0x40`) to ensure jitter-free, deterministic servo control.

| Device / Signal | ESP32-S3 Pin | PCA9685 Channel | Protocol | Functional Description |
|:---|:---:|:---:|:---:|:---|
| **I2C SDA** | **GPIO 8** | SDA | I2C Data | Hardware I2C Serial Data line |
| **I2C SCL** | **GPIO 9** | SCL | I2C Clock | Hardware I2C Serial Clock line |
| **Solar Panel ADC (+)** | **GPIO 1** | — | ADC1_CH0 | 16× oversampled analog voltage reading (0 – 3.3V) |
| **Status LED** | **GPIO 2** | — | Digital Out | Network & handshake status indicator |
| **Joint 0: Base Turntable** | — | **CH 0** | 50 Hz PWM | Azimuth sweep ($25^\circ \dots 155^\circ$, Home $90^\circ$) |
| **Joint 1: Shoulder Pitch** | — | **CH 1** | 50 Hz PWM | Elevation pitch ($35^\circ \dots 115^\circ$, Home $55^\circ$) |
| **Joint 2: Elbow Flexion** | — | **CH 2** | 50 Hz PWM | Anatomical elbow ($40^\circ \dots 125^\circ$, Home $60^\circ$) |
| **Joint 3: Wrist Tilt** | — | **CH 3** | 50 Hz PWM | Solar normal pitch ($40^\circ \dots 135^\circ$, Home $70^\circ$) |
| **Joint 4: Panel Roll** | — | **CH 4** | 50 Hz PWM | Photovoltaic fine roll ($30^\circ \dots 150^\circ$, Home $90^\circ$) |

---

## 2. Dual-Core FreeRTOS Architecture

1. **Core 0 (Networking & Sensor Telemetry)**:
   - Manages 2.4 GHz Wi-Fi connection with exponential backoff auto-reconnect.
   - Secure TLS WebSocket client connected to the Google Cloud Run broker (`wss://`).
   - 16× oversampled ADC sampling of the photovoltaic voltage sensor every 500 ms.
   - Encodes and dispatches JSON telemetry packets to the cloud dashboard.
   - Receives inbound teleoperation commands and routes target joint angles to Core 1.

2. **Core 1 (Motion Control & Actuator Interpolation)**:
   - Communicates with PCA9685 over hardware I2C at 100 kHz.
   - Smooth kinematic motion interpolation ramp (maximum 2.5° per 20 ms tick) preventing mechanical shock and current surges.
   - Fail-safe position hold in case of Wi-Fi or broker link disruption.

---

## 3. How to Compile & Flash

### Prerequisites
- [Arduino CLI](https://arduino.github.io/arduino-cli/) or Arduino IDE 2.x
- ESP32 Board Core (v2.0.14+ or v3.0+)
- Installed Arduino libraries:
  - `Adafruit-PWM-Servo-Driver-Library`
  - `WebSockets` (by Markus Sattler)
  - `ArduinoJson` (v6.x or v7.x)

### Compilation via Arduino CLI
```bash
# Navigate to firmware directory
cd firmware/esp32_s3_arm

# Compile with proper ESP32-S3 USB CDC flags
arduino-cli compile --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc,USBMode=hwcdc,FlashMode=dio,PSRAM=disabled esp32_s3_arm.ino

# Upload to the microcontroller (replace COM6 with your port)
arduino-cli upload -p COM6 --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc,USBMode=hwcdc,FlashMode=dio,PSRAM=disabled esp32_s3_arm.ino
```

### Arduino IDE 2.x Board Configuration
In the **Tools** menu, select:
1. **Board**: `ESP32S3 Dev Module`
2. **USB CDC On Boot**: `Enabled` *(Required for native USB serial monitor)*
3. **PSRAM**: `Disabled` *(Prevents bootloop on non-PSRAM modules)*
4. **Flash Mode**: `DIO 80MHz`
5. **Flash Size**: `8MB` (or `16MB` depending on your module)
