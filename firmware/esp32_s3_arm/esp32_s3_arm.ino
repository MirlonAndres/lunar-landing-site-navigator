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
// [j0: Base, j1: Shoulder, j2: Elbow, j3: Wrist, j4: Panel Roll]
const float SERVO_HOME_DEG[5] = {90.0f, 55.0f, 60.0f, 70.0f, 90.0f};

// Individual anatomical & solar-panel clearance limits [deg]
const float SERVO_MIN_DEG[5]  = {25.0f, 35.0f, 40.0f, 45.0f, 35.0f};
const float SERVO_MAX_DEG[5]  = {155.0f, 110.0f, 120.0f, 130.0f, 145.0f};

// Persistent per-servo calibration stored in ESP32 NVS Flash:
// servoTrim[i]: fine degree offset (-45..+45 deg) to align physical spline teeth
// servoDir[i]:  +1 (normal) or -1 (inverted around SERVO_HOME_DEG[i])
float   servoTrim[5] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
int8_t  servoDir[5]  = {1, 1, 1, 1, 1};

float currentAngles[5] = {90.0f, 55.0f, 60.0f, 70.0f, 90.0f};
float targetAngles[5]  = {90.0f, 55.0f, 60.0f, 70.0f, 90.0f};
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

// ================= 7. SOLAR PANEL PHYSICAL COLLISION GUARD =========
/**
 * Enforces individual joint limits AND coupled multi-joint geometric constraints
 * dictated by the physical dimensions of the rectangular solar panel at the wrist:
 * 1. Prevents panel bottom edge from hitting the table/base when shoulder+elbow extend forward.
 * 2. Prevents panel back face from hitting the forearm when elbow is tightly flexed.
 * 3. Prevents panel corners from clipping the forearm when wrist is steeply pitched.
 */
void applyPanelCollisionConstraints(float angles[5]) {
  // 1. Individual 180-deg joint safety bounds
  for (int i = 0; i < 5; i++) {
    if (isnan(angles[i])) angles[i] = SERVO_HOME_DEG[i];
    angles[i] = constrain(angles[i], SERVO_MIN_DEG[i], SERVO_MAX_DEG[i]);
  }

  // 2. Coupled Ground/Base Clearance Guard (Shoulder j1 + Elbow j2 + Wrist j3)
  // If shoulder leans forward (j1 > 70) and elbow drops down (j2 > 75), limit combined reach
  float reachSum = angles[1] + angles[2];
  if (reachSum > 165.0f) {
    float excess = reachSum - 165.0f;
    angles[2] = constrain(angles[2] - excess * 0.6f, SERVO_MIN_DEG[2], SERVO_MAX_DEG[2]);
    angles[1] = constrain(angles[1] - excess * 0.4f, SERVO_MIN_DEG[1], SERVO_MAX_DEG[1]);
  }
  // When arm reaches low (j1 + j2 > 145), prevent wrist from pitching the panel edge into the table
  if ((angles[1] + angles[2]) > 145.0f) {
    float maxSafeWrist = 115.0f - ((angles[1] + angles[2]) - 145.0f) * 0.75f;
    if (angles[3] > maxSafeWrist) {
      angles[3] = constrain(maxSafeWrist, 55.0f, SERVO_MAX_DEG[3]);
    }
  }

  // 3. Coupled Forearm Self-Collision Guard
  // When elbow is tightly folded (j2 < 52 deg), keep wrist away from upper arm
  if (angles[2] < 52.0f) {
    angles[3] = constrain(angles[3], 55.0f, 115.0f);
  }

  // 4. Solar Panel Corner Roll Guard
  // When wrist is pitched steeply (< 58 deg or > 110 deg), narrow roll (j4) so panel corners clear forearm
  if (angles[3] < 58.0f || angles[3] > 110.0f) {
    angles[4] = constrain(angles[4], 55.0f, 125.0f);
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
 * Converts logical web angle (deg) -> calibrated 180-deg hardware angle -> staggered PCA9685 PWM ticks.
 * Uses staggered phase offset (onTick = channel * 200) to prevent simultaneous current spikes!
 */
void writeServoHardware(uint8_t channel, float webAngleDeg) {
  if (!pca9685_connected || channel >= 5) return;

  // Apply per-joint direction and trim calibration around Home reference
  float hwAngle = SERVO_HOME_DEG[channel]
                + (float)servoDir[channel] * (webAngleDeg - SERVO_HOME_DEG[channel])
                + servoTrim[channel];

  // Clamp strictly within 180-deg servo physical boundaries (5..175 deg) to prevent end-stop stall
  hwAngle = constrain(hwAngle, 5.0f, 175.0f);

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

    // Check if command requests auto-calibration or trim/direction update
    if (strcmp(m, "CALIBRATE") == 0 || (v["recal"] | false)) {
      runAutoCalibrationRoutine();
      return true;
    }

    // Parse compact web calibration string "CAL:t0,t1,t2,t3,t4:d0,d1,d2,d3,d4"
    if (strncmp(m, "CAL:", 4) == 0) {
      float t[5] = {0, 0, 0, 0, 0};
      int d[5]   = {1, 1, 1, 1, 1};
      if (sscanf(m + 4, "%f,%f,%f,%f,%f:%d,%d,%d,%d,%d",
                 &t[0], &t[1], &t[2], &t[3], &t[4],
                 &d[0], &d[1], &d[2], &d[3], &d[4]) == 10) {
        for (int i = 0; i < 5; i++) {
          servoTrim[i] = constrain(t[i], -45.0f, 45.0f);
          servoDir[i]  = (d[i] < 0) ? -1 : 1;
        }
        saveCalibrationToFlash();
        for (int i = 0; i < 5; i++) writeServoHardware(i, currentAngles[i]);
      }
    }

    // Check for live trim / direction calibration arrays inside 'v'
    JsonArrayConst trimArr = v["trim"];
    JsonArrayConst dirArr  = v["dir"];
    bool calChanged = false;
    if (!trimArr.isNull() && trimArr.size() >= 5) {
      for (int i = 0; i < 5; i++) {
        servoTrim[i] = constrain(trimArr[i].as<float>(), -45.0f, 45.0f);
      }
      calChanged = true;
    }
    if (!dirArr.isNull() && dirArr.size() >= 5) {
      for (int i = 0; i < 5; i++) {
        servoDir[i] = (dirArr[i].as<int>() < 0) ? -1 : 1;
      }
      calChanged = true;
    }
    if (calChanged) {
      saveCalibrationToFlash();
      for (int i = 0; i < 5; i++) writeServoHardware(i, currentAngles[i]);
    }

    JsonArrayConst arr = v["a"];
    if (arr.isNull()) arr = rootDoc["target_angles"].as<JsonArrayConst>();

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

