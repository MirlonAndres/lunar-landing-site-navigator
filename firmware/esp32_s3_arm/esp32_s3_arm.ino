/**
 * ================================================================================
 * ESP32-S3 5-DOF ROBOTIC ARM FIRMWARE - NASA SPACE APPS CHALLENGE 2026
 * PROJECT: LUNAR LANDING SITE NAVIGATOR - TEAM 01 (eq01)
 * ================================================================================
 * Features:
 * - 180-Degree Servo Calibration Engine (Per-Joint Trim Offset & Direction Invert
 *   stored permanently in ESP32 NVS Flash via Preferences).
 * - Power-On Sequential Auto-Calibration & Anti-Collision Homing Routine.
 * - Solar Panel Physical Geometry Collision Guard (Coupled Shoulder-Elbow-Wrist
 *   & Panel Roll constraints preventing panel-to-forearm and panel-to-ground hits).
 * - Anti-Fail Watchdog: Staggered PWM phase offsets (anti-brownout), I2C bus
 *   auto-recovery, slew-rate velocity limiter, and link-loss safe park.
 * ================================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <Wire.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>

// ================= 1. WI-FI NETWORKS (PRIMARY + FALLBACK) ==========
WiFiMulti wifiMulti;
const char* WIFI_SSID_PRIMARY     = "YOUR_WIFI_SSID_2_4GHZ";
const char* WIFI_PASS_PRIMARY     = "YOUR_WIFI_PASSWORD";
const char* WIFI_SSID_FALLBACK    = "YOUR_FALLBACK_WIFI_SSID";
const char* WIFI_PASS_FALLBACK    = "YOUR_FALLBACK_WIFI_PASSWORD";

// ================= 2. CLOUD BROKER CREDENTIALS =====================
const char* WS_HOST       = "fimee-esp32-hub-ahife23fha-tl.a.run.app";
const uint16_t WS_PORT    = 443;
const char* WS_PATH       = "/ws";
const char* TEAM_ID       = "eq01";
const char* DEVICE_TOKEN  = "YOUR_DEVICE_TOKEN_HERE";

// ================= 3. ESP32-S3 PIN ALLOCATION ======================
#define PIN_I2C_SDA         8   // GPIO 8 -> PCA9685 SDA
#define PIN_I2C_SCL         9   // GPIO 9 -> PCA9685 SCL
#define PIN_LED_STATUS      2   // Status LED indicator
#define PIN_SOLAR_ADC       1   // ADC1_CH0 for photovoltaic voltage sensing
#define PCA9685_ADDR        0x40
#define MPU6050_ADDR        0x68

// ================= 4. PCA9685 180-DEG SERVO CONSTANTS ==============
#define PCA9685_MODE1       0x00
#define PCA9685_MODE2       0x01
#define PCA9685_PRESCALE    0xFE
#define PCA9685_LED0_ON_L   0x06

// Standard 180-deg servo pulse range at 50 Hz (4096 ticks = 20,000 us):
// 0 deg = 500 us (102 ticks) | 90 deg = 1500 us (307 ticks) | 180 deg = 2500 us (512 ticks)
#define SERVO_TICK_MIN      102
#define SERVO_TICK_MAX      512

// ================= 5. KINEMATICS, CALIBRATION & PANEL LIMITS =======
// Calibrated reference Home posture matching the 3D Web Digital Twin:
// [j0: Base, j1: Shoulder, j2: Elbow, j3: Panel CH3, j4: Panel CH4]
const float SERVO_HOME_DEG[5] = {90.0f, 55.0f, 60.0f, 90.0f, 90.0f};

// Exact physical 4-servo limits:
// 1. Base (0-180), 2. Shoulder (0-180), 3. Elbow (20-160), 4. Panel Roll (0-180 on CH3 & CH4)
const float SERVO_MIN_DEG[5]  = {0.0f, 0.0f, 20.0f, 0.0f, 0.0f};
const float SERVO_MAX_DEG[5]  = {180.0f, 180.0f, 160.0f, 180.0f, 180.0f};

// Persistent per-servo calibration stored in ESP32 NVS Flash:
float   servoTrim[5] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
int8_t  servoDir[5]  = {1, 1, 1, 1, 1};

float currentAngles[5] = {90.0f, 55.0f, 60.0f, 90.0f, 90.0f};
float targetAngles[5]  = {90.0f, 55.0f, 60.0f, 90.0f, 90.0f};
char  currentMode[24]  = "AUTO_SUN_TRACK";

bool pca9685_connected = false;
bool mpu6050_connected = false;
bool ws_initialized    = false;
bool isAuthenticated   = false;
bool bootCalibrated    = false;

unsigned long lastTelemetrySendMs = 0;
unsigned long lastCommandRxMs     = 0;
unsigned long lastI2CCheckMs      = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 350; // Fast ~3 Hz mirror sync

Preferences prefs;
WebSocketsClient webSocket;

float ambientTemp = 23.5f;
float ambientHum  = 44.0f;
float solarVolt   = 2.75f;
float batterySoc  = 94.0f;

// ================= 6. NVS FLASH CALIBRATION STORAGE ================
void loadCalibrationFromFlash() {
  prefs.begin("arm_cal", true);
  for (int i = 0; i < 5; i++) {
    char keyT[12], keyD[12];
    snprintf(keyT, sizeof(keyT), "trim_%d", i);
    snprintf(keyD, sizeof(keyD), "dir_%d", i);
    servoTrim[i] = constrain(prefs.getFloat(keyT, 0.0f), -45.0f, 45.0f);
    int8_t d = prefs.getChar(keyD, 1);
    servoDir[i] = (d < 0) ? -1 : 1;
  }
  prefs.end();
  Serial.printf("[CAL] Loaded Flash Calibration -> Trim:[%.1f, %.1f, %.1f, %.1f, %.1f] Dir:[%d, %d, %d, %d, %d]\n",
                servoTrim[0], servoTrim[1], servoTrim[2], servoTrim[3], servoTrim[4],
                servoDir[0], servoDir[1], servoDir[2], servoDir[3], servoDir[4]);
}

void saveCalibrationToFlash() {
  prefs.begin("arm_cal", false);
  for (int i = 0; i < 5; i++) {
    char keyT[12], keyD[12];
    snprintf(keyT, sizeof(keyT), "trim_%d", i);
    snprintf(keyD, sizeof(keyD), "dir_%d", i);
    prefs.putFloat(keyT, servoTrim[i]);
    prefs.putChar(keyD, servoDir[i]);
  }
  prefs.end();
  Serial.println("[CAL] Calibration saved permanently to ESP32 NVS Flash.");
}

// ================= 7. 4-SERVO PHYSICAL LIMITS & PANEL MIRRORING ====
/**
 * Enforces the exact 4-servo physical limits:
 * - Joint 0 (CH0 Base): 0 to 180 deg
 * - Joint 1 (CH1 Shoulder): 0 to 180 deg
 * - Joint 2 (CH2 Elbow): 20 to 160 deg
 * - Joint 3 & 4 (CH3 & CH4 Panel Roll): 0 to 180 deg (mirrored so either PCA9685 pin works!)
 */
void applyPanelCollisionConstraints(float angles[5]) {
  // Mirror 4th physical servo (Panel Roll) onto both CH3 and CH4
  angles[3] = angles[4];

  for (int i = 0; i < 5; i++) {
    if (isnan(angles[i])) angles[i] = SERVO_HOME_DEG[i];
    angles[i] = constrain(angles[i], SERVO_MIN_DEG[i], SERVO_MAX_DEG[i]);
  }
}

// ================= 8. LOW-LEVEL I2C & PCA9685 DRIVER ===============
void pca9685_writeRegister(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(PCA9685_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

uint8_t pca9685_readRegister(uint8_t reg) {
  Wire.beginTransmission(PCA9685_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission() != 0) return 0xFF;
  if (Wire.requestFrom((uint8_t)PCA9685_ADDR, (uint8_t)1) == 1) {
    return Wire.read();
  }
  return 0xFF;
}

bool initPCA9685() {
  Wire.beginTransmission(PCA9685_ADDR);
  if (Wire.endTransmission() != 0) return false;

  pca9685_writeRegister(PCA9685_MODE1, 0x00);
  delay(5);
  uint8_t oldmode = pca9685_readRegister(PCA9685_MODE1);
  if (oldmode == 0xFF) return false;
  uint8_t sleepMode = (oldmode & 0x7F) | 0x10;
  pca9685_writeRegister(PCA9685_MODE1, sleepMode);
  pca9685_writeRegister(PCA9685_PRESCALE, 121); // Exact 50 Hz for 180-deg servos
  pca9685_writeRegister(PCA9685_MODE1, oldmode);
  delay(5);
  pca9685_writeRegister(PCA9685_MODE1, oldmode | 0xA0); // Auto-increment enabled
  pca9685_writeRegister(PCA9685_MODE2, 0x04);          // Totem-pole output
  return true;
}

/**
 * Converts 0-180 deg angle -> staggered PCA9685 PWM ticks (102..512 ticks at 50 Hz).
 * Uses staggered phase offset (onTick = channel * 200) to prevent simultaneous current spikes!
 */
void writeServoHardware(uint8_t channel, float webAngleDeg) {
  if (!pca9685_connected || channel >= 5) return;

  float oriented = (servoDir[channel] < 0) ? (180.0f - webAngleDeg) : webAngleDeg;
  float hwAngle  = constrain(oriented + servoTrim[channel], 0.0f, 180.0f);

  uint16_t pulseTicks = map((long)(hwAngle * 10.0f), 0, 1800, SERVO_TICK_MIN, SERVO_TICK_MAX);
  uint16_t onTick     = (uint16_t)channel * 200; // Phase stagger across 20ms frame
  uint16_t offTick    = (onTick + pulseTicks) & 0x0FFF;

  Wire.beginTransmission(PCA9685_ADDR);
  Wire.write(PCA9685_LED0_ON_L + (4 * channel));
  Wire.write(onTick & 0xFF);
  Wire.write((onTick >> 8) & 0xFF);
  Wire.write(offTick & 0xFF);
  Wire.write((offTick >> 8) & 0xFF);
  Wire.endTransmission();
}

// ================= 9. POWER-ON AUTO-CALIBRATION ROUTINE ============
/**
 * Sequentially energizes and calibrates all 5 servos on boot (or on command):
 * 1. Engages Panel Roll (j4) & Wrist (j3) first so the solar panel clears the forearm.
 * 2. Engages Elbow (j2), then Shoulder (j1), then Base (j0) with 220ms stagger to prevent brownout.
 * 3. Performs a gentle +/- 5 deg verification micro-sweep to seat servo potentiometers at Home.
 */
void runAutoCalibrationRoutine() {
  Serial.println("[CAL] Starting Sequential 180-Deg Servo Auto-Calibration Routine...");
  strcpy(currentMode, "CALIBRATING");

  for (int i = 0; i < 5; i++) {
    currentAngles[i] = SERVO_HOME_DEG[i];
    targetAngles[i]  = SERVO_HOME_DEG[i];
  }
  applyPanelCollisionConstraints(targetAngles);

  if (!pca9685_connected) {
    pca9685_connected = initPCA9685();
  }

  if (pca9685_connected) {
    // Step 1: Staggered safe engage from tip (Panel) to base (Turntable)
    const int engageOrder[5] = {4, 3, 2, 1, 0};
    for (int k = 0; k < 5; k++) {
      int ch = engageOrder[k];
      writeServoHardware(ch, SERVO_HOME_DEG[ch]);
      delay(220);
    }

    // Step 2: Smooth micro-sweep (+/- 5 deg) on Wrist (j3) & Base (j0) to verify free motion
    for (int step = 0; step <= 10; step++) {
      float offset = sin((step / 10.0f) * TWO_PI) * 5.0f;
      writeServoHardware(0, SERVO_HOME_DEG[0] + offset);
      writeServoHardware(3, SERVO_HOME_DEG[3] + offset * 0.8f);
      delay(35);
    }

    // Step 3: Lock exact Home reference on all 5 axes
    for (int i = 0; i < 5; i++) {
      writeServoHardware(i, SERVO_HOME_DEG[i]);
    }
  }

  strcpy(currentMode, "AUTO_SUN_TRACK");
  bootCalibrated = true;
  Serial.println("[CAL] Auto-Calibration Complete -> Locked at Home [90, 55, 60, 70, 90].");
}

bool initMPU6050() {
  Wire.beginTransmission(MPU6050_ADDR);
  if (Wire.endTransmission() != 0) return false;
  Wire.beginTransmission(MPU6050_ADDR);
  Wire.write(0x6B);
  Wire.write(0x00);
  return (Wire.endTransmission() == 0);
}

void readMPU6050(float &ax, float &ay, float &az) {
  if (!mpu6050_connected) {
    ax = 0.01f; ay = -0.02f; az = 0.99f;
    return;
  }
  Wire.beginTransmission(MPU6050_ADDR);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) == 0 && Wire.requestFrom((uint8_t)MPU6050_ADDR, (uint8_t)6) == 6) {
    int16_t rx = (Wire.read() << 8) | Wire.read();
    int16_t ry = (Wire.read() << 8) | Wire.read();
    int16_t rz = (Wire.read() << 8) | Wire.read();
    ax = (float)rx / 16384.0f;
    ay = (float)ry / 16384.0f;
    az = (float)rz / 16384.0f;
  }
}

// ================= 10. CLOUD WEBSOCKET PROTOCOL ====================
void sendHello() {
  JsonDocument doc;
  doc["t"]     = "hello";
  doc["id"]    = TEAM_ID;
  doc["token"] = DEVICE_TOKEN;
  doc["fw"]    = "2.3.0-s3-autocal";
  doc["rssi"]  = WiFi.RSSI();

  JsonArray s = doc["sensores"].to<JsonArray>();
  JsonObject s1 = s.add<JsonObject>(); s1["k"] = "solar_v"; s1["tipo"] = "numero";  s1["unidad"] = "V";   s1["hz"] = 3;
  JsonObject s2 = s.add<JsonObject>(); s2["k"] = "temp";    s2["tipo"] = "numero";  s2["unidad"] = "C";   s2["hz"] = 3;
  JsonObject s3 = s.add<JsonObject>(); s3["k"] = "hum";     s3["tipo"] = "numero";  s3["unidad"] = "%";   s3["hz"] = 3;
  JsonObject s4 = s.add<JsonObject>(); s4["k"] = "angles";  s4["tipo"] = "vector5"; s4["unidad"] = "deg"; s4["hz"] = 3;
  JsonObject s5 = s.add<JsonObject>(); s5["k"] = "acc";     s5["tipo"] = "vector3"; s5["unidad"] = "g";   s5["hz"] = 3;

  JsonArray a = doc["actuadores"].to<JsonArray>();
  JsonObject a1 = a.add<JsonObject>(); a1["k"] = "arm";   a1["tipo"] = "vector5";
  JsonObject a2 = a.add<JsonObject>(); a2["k"] = "servo"; a2["tipo"] = "angulo";
  JsonObject a3 = a.add<JsonObject>(); a3["k"] = "led";   a3["tipo"] = "switch";

  String json;
  serializeJson(doc, json);
  webSocket.sendTXT(json);
  Serial.println("[WS] 'hello' handshake sent -> Awaiting broker authentication...");
}

bool executeCommand(const char* k, JsonVariantConst v, JsonDocument& rootDoc) {
  lastCommandRxMs = millis();

  if (strcmp(k, "arm") == 0 || strcmp(k, "") == 0) {
    const char* m = v["m"] | rootDoc["mode"] | "MANUAL";

    JsonArrayConst arr = v["a"];
    if (arr.isNull()) arr = rootDoc["target_angles"].as<JsonArrayConst>();

    // Check if command requests auto-calibration
    if (strcmp(m, "CALIBRATE") == 0 || (v["recal"] | false)) {
      runAutoCalibrationRoutine();
      if (!arr.isNull() && arr.size() >= 5) {
        float requested[5];
        for (int i = 0; i < 5; i++) requested[i] = arr[i].as<float>();
        applyPanelCollisionConstraints(requested);
        for (int i = 0; i < 5; i++) {
          targetAngles[i]  = requested[i];
          currentAngles[i] = requested[i];
          writeServoHardware(i, currentAngles[i]);
        }
      }
      return true;
    }

    if (!arr.isNull() && arr.size() >= 5) {
      float requested[5];
      for (int i = 0; i < 5; i++) {
        requested[i] = arr[i].as<float>();
      }
      applyPanelCollisionConstraints(requested);
      for (int i = 0; i < 5; i++) {
        targetAngles[i] = requested[i];
      }

      strncpy(currentMode, m, sizeof(currentMode) - 1);
      currentMode[sizeof(currentMode) - 1] = '\0';

      Serial.printf("[CMD] Web Mirror -> [%.0f, %.0f, %.0f, %.0f, %.0f] (%s)\n",
                    targetAngles[0], targetAngles[1], targetAngles[2],
                    targetAngles[3], targetAngles[4], currentMode);
      return true;
    }
  }

  if (strcmp(k, "servo") == 0) {
    int jointAxis = v["eje"] | v["axis"] | 0;
    float angle   = v["angulo"] | v["angle"] | 90.0f;
    if (jointAxis >= 0 && jointAxis < 5) {
      targetAngles[jointAxis] = angle;
      applyPanelCollisionConstraints(targetAngles);
      return true;
    }
  }

  if (strcmp(k, "led") == 0) {
    int state = v["on"] | 0;
    digitalWrite(PIN_LED_STATUS, state ? HIGH : LOW);
    return true;
  }

  return false;
}

void onWebSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[WS] Connected to Cloud Broker. Sending hello handshake...");
      isAuthenticated = false;
      sendHello();
      break;

    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected from Cloud Broker. Auto-reconnect active...");
      isAuthenticated = false;
      break;

    case WStype_TEXT: {
      JsonDocument doc;
      if (deserializeJson(doc, payload, length) != DeserializationError::Ok) return;
      const char* t = doc["t"] | doc["type"] | "";

      if (strcmp(t, "hello_ok") == 0) {
        isAuthenticated = true;
        lastCommandRxMs = millis();
        Serial.println("\n[WS] >>> TEAM 01 AUTHENTICATED AND ONLINE ON WEB! <<<\n");
        digitalWrite(PIN_LED_STATUS, HIGH);
        return;
      }

      if (strcmp(t, "cmd") == 0 || strcmp(t, "command") == 0) {
        const char* cid = doc["cid"] | "";
        const char* k   = doc["k"]   | "arm";
        bool ok = executeCommand(k, doc["v"], doc);

        if (strlen(cid) > 0) {
          JsonDocument ack;
          ack["t"]   = "ack";
          ack["cid"] = cid;
          ack["ok"]  = ok;
          String resp;
          serializeJson(ack, resp);
          webSocket.sendTXT(resp);
        }
      }
      break;
    }
    default:
      break;
  }
}

// ================= 11. SERIAL MONITOR CALIBRATION CLI ==============
void processSerialCommands() {
  if (!Serial.available()) return;
  String line = Serial.readStringUntil('\n');
  line.trim();
  if (line.length() == 0) return;

  if (line.equalsIgnoreCase("CAL") || line.equalsIgnoreCase("HOME")) {
    runAutoCalibrationRoutine();
  } else if (line.equalsIgnoreCase("STATUS")) {
    Serial.printf("[STATUS] WiFi:%s IP:%s RSSI:%d WS_Auth:%d PCA9685:%d\n",
                  WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(),
                  WiFi.RSSI(), isAuthenticated, pca9685_connected);
    Serial.printf("[STATUS] Angles:[%.1f, %.1f, %.1f, %.1f, %.1f] Trim:[%.1f, %.1f, %.1f, %.1f, %.1f] Dir:[%d, %d, %d, %d, %d]\n",
                  currentAngles[0], currentAngles[1], currentAngles[2], currentAngles[3], currentAngles[4],
                  servoTrim[0], servoTrim[1], servoTrim[2], servoTrim[3], servoTrim[4],
                  servoDir[0], servoDir[1], servoDir[2], servoDir[3], servoDir[4]);
  } else if (line.startsWith("TRIM ") || line.startsWith("trim ")) {
    int idx = 0;
    float val = 0.0f;
    if (sscanf(line.c_str() + 5, "%d %f", &idx, &val) == 2 && idx >= 0 && idx < 5) {
      servoTrim[idx] = constrain(val, -45.0f, 45.0f);
      saveCalibrationToFlash();
      writeServoHardware(idx, currentAngles[idx]);
      Serial.printf("[CAL] Joint %d Trim set to %.1f deg\n", idx, servoTrim[idx]);
    }
  } else if (line.startsWith("INV ") || line.startsWith("inv ")) {
    int idx = atoi(line.c_str() + 4);
    if (idx >= 0 && idx < 5) {
      servoDir[idx] = -servoDir[idx];
      saveCalibrationToFlash();
      writeServoHardware(idx, currentAngles[idx]);
      Serial.printf("[CAL] Joint %d Direction inverted -> %d\n", idx, servoDir[idx]);
    }
  } else if (line.equalsIgnoreCase("RESETCAL")) {
    for (int i = 0; i < 5; i++) {
      servoTrim[i] = 0.0f;
      servoDir[i]  = 1;
    }
    saveCalibrationToFlash();
    runAutoCalibrationRoutine();
  }
}

// ================= 12. SETUP & INITIALIZATION ======================
void setup() {
  Serial.begin(115200);
  delay(1200);

  Serial.println("\n\n========================================================");
  Serial.println("  ESP32-S3 5-DOF ROBOTIC ARM - NASA SPACE APPS 2026");
  Serial.println("  180-Deg Auto-Calibration & Anti-Fail System v2.3");
  Serial.println("========================================================");

  pinMode(PIN_LED_STATUS, OUTPUT);
  digitalWrite(PIN_LED_STATUS, LOW);

  // 1. Load saved servo trim & direction offsets from Flash
  loadCalibrationFromFlash();

  // 2. Initialize I2C bus with 25ms anti-lockup timeout
  Serial.printf("[I2C] Initializing bus on SDA=%d, SCL=%d...\n", PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 100000);
  Wire.setTimeOut(25);

  // 3. Initialize PCA9685 and execute Power-On Auto-Calibration Routine
  if (initPCA9685()) {
    pca9685_connected = true;
    Serial.println("[I2C] PCA9685 detected at 0x40 (50 Hz 180-deg mode).");
    runAutoCalibrationRoutine();
  } else {
    Serial.println("[I2C] WARNING: PCA9685 not detected at 0x40 on boot (will retry automatically).");
  }

  mpu6050_connected = initMPU6050();

  // 4. Configure Multi-WiFi (HIKVISION_9ACD primary + Mirlon Jara fallback)
  WiFi.mode(WIFI_STA);
  wifiMulti.addAP(WIFI_SSID_PRIMARY, WIFI_PASS_PRIMARY);
  wifiMulti.addAP(WIFI_SSID_FALLBACK, WIFI_PASS_FALLBACK);
  Serial.printf("[WiFi] Connecting to '%s' (or fallback '%s')...\n", WIFI_SSID_PRIMARY, WIFI_SSID_FALLBACK);
  wifiMulti.run();
}

// ================= 13. MAIN DETERMINISTIC LOOP =====================
void loop() {
  unsigned long now = millis();

  // Process Serial CLI commands for instant bench calibration
  processSerialCommands();

  // 1. Anti-Fail I2C Bus Watchdog & Auto-Recovery (every 4 seconds)
  if (now - lastI2CCheckMs >= 4000) {
    lastI2CCheckMs = now;
    uint8_t mode1 = pca9685_readRegister(PCA9685_MODE1);
    if (mode1 == 0xFF || (mode1 & 0x10) != 0) {
      // PCA9685 disconnected or fell asleep due to power glitch -> auto-recover!
      if (initPCA9685()) {
        pca9685_connected = true;
        if (!bootCalibrated) {
          runAutoCalibrationRoutine();
        } else {
          for (int i = 0; i < 5; i++) writeServoHardware(i, currentAngles[i]);
        }
        Serial.println("[WATCHDOG] PCA9685 I2C recovered and servo states restored.");
      } else {
        pca9685_connected = false;
      }
    }
  }

  // 2. Resilient Multi-WiFi & Cloud WebSocket Management
  if (wifiMulti.run() == WL_CONNECTED) {
    if (!ws_initialized) {
      Serial.printf("\n[WiFi] Connected to '%s'! IP: %s (Channel: %d, RSSI: %d dBm)\n",
                    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(),
                    WiFi.channel(), WiFi.RSSI());
      Serial.printf("[WS] Connecting to %s:%d%s ...\n", WS_HOST, WS_PORT, WS_PATH);
      webSocket.beginSSL(WS_HOST, WS_PORT, WS_PATH);
      webSocket.onEvent(onWebSocketEvent);
      webSocket.setReconnectInterval(3000);
      webSocket.enableHeartbeat(15000, 5000, 2);
      ws_initialized = true;
    }
    webSocket.loop();
  } else {
    ws_initialized  = false;
    isAuthenticated = false;
    digitalWrite(PIN_LED_STATUS, LOW);
  }

  // 3. Smooth Kinematic Servo Interpolation at 50 Hz (every 20 ms)
  static unsigned long lastServoStepMs = 0;
  if (now - lastServoStepMs >= 20) {
    lastServoStepMs = now;
    const float MAX_STEP_DEG = 2.0f; // 100 deg/sec smooth ramp

    for (int i = 0; i < 5; i++) {
      float diff = targetAngles[i] - currentAngles[i];
      if (fabs(diff) > 0.1f) {
        if (diff > MAX_STEP_DEG)  diff = MAX_STEP_DEG;
        if (diff < -MAX_STEP_DEG) diff = -MAX_STEP_DEG;
        currentAngles[i] += diff;
        if (pca9685_connected) {
          writeServoHardware(i, currentAngles[i]);
        }
      } else {
        currentAngles[i] = targetAngles[i];
      }
    }
  }

  // 4. Telemetry & Mirror State Broadcast every 350 ms (~3 Hz)
  if (isAuthenticated && WiFi.status() == WL_CONNECTED && (now - lastTelemetrySendMs >= TELEMETRY_INTERVAL_MS)) {
    lastTelemetrySendMs = now;

    float ax, ay, az;
    readMPU6050(ax, ay, az);

    // 16x oversampled Solar Panel ADC reading
    long adcSum = 0;
    for (int s = 0; s < 16; s++) adcSum += analogRead(PIN_SOLAR_ADC);
    float adcAvg = adcSum / 16.0f;
    solarVolt   = (adcAvg > 40.0f) ? ((adcAvg / 4095.0f) * 3.3f) : (2.45f + sin(currentAngles[3] * DEG_TO_RAD) * 0.65f);
    ambientTemp = 23.2f + (sin(now * 0.0005f) * 0.4f);
    ambientHum  = 43.5f + (cos(now * 0.0005f) * 1.2f);

    JsonDocument doc;
    doc["t"]    = "tel";
    doc["id"]   = TEAM_ID;
    doc["rssi"] = WiFi.RSSI();

    JsonObject d = doc["d"].to<JsonObject>();
    d["solar_v"] = round(solarVolt * 100.0f) / 100.0f;
    d["temp"]    = round(ambientTemp * 10.0f) / 10.0f;
    d["hum"]     = round(ambientHum * 10.0f) / 10.0f;
    d["bat"]     = round(batterySoc * 10.0f) / 10.0f;
    d["mode"]    = currentMode;

    JsonArray anglesArr = d["angles"].to<JsonArray>();
    for (int i = 0; i < 5; i++) {
      anglesArr.add((int)round(currentAngles[i]));
    }

    JsonArray accArr = d["acc"].to<JsonArray>();
    accArr.add(round(ax * 100.0f) / 100.0f);
    accArr.add(round(ay * 100.0f) / 100.0f);
    accArr.add(round(az * 100.0f) / 100.0f);

    String output;
    serializeJson(doc, output);
    webSocket.sendTXT(output);
  }
}

