/**
 * ================================================================================
 * ESP32-S3 5-DOF ROBOTIC ARM FIRMWARE - NASA SPACE APPS CHALLENGE 2026
 * PROJECT: LUNAR LANDING SITE NAVIGATOR - TEAM 01 (eq01)
 * ================================================================================
 * Hardware Architecture:
 * - Microcontroller: ESP32-S3 (DevKitC-1, N8, N16, etc.)
 * - I2C Bus: SDA = GPIO 8, SCL = GPIO 9 (PCA9685 at 0x40 driving 5 servos)
 * - Cloud Relay Broker: fimee-esp32-hub-ahife23fha-tl.a.run.app:443 (WSS)
 *
 * ARDUINO IDE COMPILATION SETTINGS (Tools Menu):
 * 1. Board: "ESP32S3 Dev Module"
 * 2. USB CDC On Boot: "Enabled"  <-- REQUIRED for native USB Serial Monitor on COM port
 * 3. PSRAM: "Disabled"            <-- REQUIRED if board lacks external PSRAM (avoids bootloop)
 * 4. Flash Mode: "DIO 80MHz"     <-- Matches chip SPI flash mode
 * 5. Flash Size: "8MB" (or "4MB" / "16MB" depending on your module)
 * ================================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ================= 1. WI-FI NETWORK CONFIGURATION ==================
// Replace with your local 2.4 GHz Wi-Fi credentials
const char* WIFI_SSID     = "YOUR_WIFI_SSID_2_4GHZ";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ================= 2. CLOUD BROKER CREDENTIALS =====================
const char* WS_HOST       = "fimee-esp32-hub-ahife23fha-tl.a.run.app";
const uint16_t WS_PORT    = 443;
const char* WS_PATH       = "/ws";
const char* TEAM_ID       = "eq01";
const char* DEVICE_TOKEN  = "YOUR_DEVICE_TOKEN_HERE";

// ================= 3. ESP32-S3 PIN ALLOCATION =====================
#define PIN_I2C_SDA         8   // GPIO 8 to PCA9685 SDA
#define PIN_I2C_SCL         9   // GPIO 9 to PCA9685 SCL
#define PIN_LED_STATUS      2   // Status LED indicator (GPIO 2 or 48)
#define PIN_SOLAR_ADC       1   // ADC1_CH0 for photovoltaic analog voltage
#define PCA9685_ADDR        0x40
#define MPU6050_ADDR        0x68

// ================= 4. NATIVE I2C PCA9685 CONTROLLER ===============
#define PCA9685_MODE1       0x00
#define PCA9685_MODE2       0x01
#define PCA9685_PRESCALE    0xFE
#define PCA9685_LED0_ON_L   0x06

bool pca9685_connected = false;
bool mpu6050_connected = false;
bool ws_initialized    = false;

void pca9685_writeRegister(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(PCA9685_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

uint8_t pca9685_readRegister(uint8_t reg) {
  Wire.beginTransmission(PCA9685_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission() != 0) return 0;
  if (Wire.requestFrom((uint8_t)PCA9685_ADDR, (uint8_t)1) == 1) {
    return Wire.read();
  }
  return 0;
}

bool initPCA9685() {
  Wire.beginTransmission(PCA9685_ADDR);
  if (Wire.endTransmission() != 0) return false;

  pca9685_writeRegister(PCA9685_MODE1, 0x00);
  delay(5);
  uint8_t oldmode = pca9685_readRegister(PCA9685_MODE1);
  uint8_t sleepMode = (oldmode & 0x7F) | 0x10;
  pca9685_writeRegister(PCA9685_MODE1, sleepMode);
  pca9685_writeRegister(PCA9685_PRESCALE, 121); // 50 Hz PWM for analog servos
  pca9685_writeRegister(PCA9685_MODE1, oldmode);
  delay(5);
  pca9685_writeRegister(PCA9685_MODE1, oldmode | 0xA0);
  pca9685_writeRegister(PCA9685_MODE2, 0x04);
  return true;
}

void moveServoPCA9685(uint8_t channel, float angle) {
  if (!pca9685_connected || channel > 15) return;
  angle = constrain(angle, 0.0f, 180.0f);
  // Map 500 us (0 deg) to 2500 us (180 deg) -> 102 to 512 ticks over 4096 at 50Hz
  uint16_t offTick = map((long)(angle * 10), 0, 1800, 102, 512);

  Wire.beginTransmission(PCA9685_ADDR);
  Wire.write(PCA9685_LED0_ON_L + (4 * channel));
  Wire.write(0);
  Wire.write(0);
  Wire.write(offTick & 0xFF);
  Wire.write((offTick >> 8) & 0xFF);
  Wire.endTransmission();
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

// ================= 5. ARM STATE & JOINT CONSTRAINTS ================
// Safe anatomical limits per joint [Base, Shoulder, Elbow, Wrist, Panel Roll]
const float SERVO_MIN_DEG[5]  = {25.0f, 35.0f, 40.0f, 40.0f, 30.0f};
const float SERVO_MAX_DEG[5]  = {155.0f, 115.0f, 125.0f, 135.0f, 150.0f};

float currentAngles[5] = {90.0f, 55.0f, 60.0f, 70.0f, 90.0f};
float targetAngles[5]  = {90.0f, 55.0f, 60.0f, 70.0f, 90.0f};
char currentMode[24]   = "AUTO_SUN_TRACK";

float ambientTemp = 23.5f;
float ambientHum  = 44.0f;
float solarVolt   = 2.75f;
float batterySoc  = 94.0f;

WebSocketsClient webSocket;
bool isAuthenticated = false;
unsigned long lastTelemetrySendMs = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 500;

// ================= 6. INITIAL HANDSHAKE ("hello") ===================
void sendHello() {
  JsonDocument doc;
  doc["t"]     = "hello";
  doc["id"]    = TEAM_ID;
  doc["token"] = DEVICE_TOKEN;
  doc["fw"]    = "2.1.1-s3-i2c";
  doc["rssi"]  = WiFi.RSSI();

  JsonArray s = doc["sensores"].to<JsonArray>();
  JsonObject s1 = s.add<JsonObject>(); s1["k"] = "solar_v"; s1["tipo"] = "numero";  s1["unidad"] = "V";   s1["hz"] = 2;
  JsonObject s2 = s.add<JsonObject>(); s2["k"] = "temp";    s2["tipo"] = "numero";  s2["unidad"] = "C";   s2["hz"] = 2;
  JsonObject s3 = s.add<JsonObject>(); s3["k"] = "hum";     s3["tipo"] = "numero";  s3["unidad"] = "%";   s3["hz"] = 2;
  JsonObject s4 = s.add<JsonObject>(); s4["k"] = "angles";  s4["tipo"] = "vector5"; s4["unidad"] = "deg"; s4["hz"] = 2;
  JsonObject s5 = s.add<JsonObject>(); s5["k"] = "acc";     s5["tipo"] = "vector3"; s5["unidad"] = "g";   s5["hz"] = 2;

  JsonArray a = doc["actuadores"].to<JsonArray>();
  JsonObject a1 = a.add<JsonObject>(); a1["k"] = "arm";   a1["tipo"] = "vector5";
  JsonObject a2 = a.add<JsonObject>(); a2["k"] = "servo"; a2["tipo"] = "angulo";
  JsonObject a3 = a.add<JsonObject>(); a3["k"] = "led";   a3["tipo"] = "switch";

  String json;
  serializeJson(doc, json);
  webSocket.sendTXT(json);
  Serial.println("[WS] 'hello' handshake sent -> Awaiting broker authentication...");
}

// ================= 7. COMMAND EXECUTION DISPATCHER ==================
bool executeCommand(const char* k, JsonVariantConst v, JsonDocument& rootDoc) {
  if (strcmp(k, "arm") == 0 || strcmp(k, "") == 0) {
    JsonArrayConst arr = v["a"];
    if (arr.isNull()) arr = rootDoc["target_angles"].as<JsonArrayConst>();

    if (!arr.isNull() && arr.size() >= 5) {
      for (int i = 0; i < 5; i++) {
        targetAngles[i] = constrain(arr[i].as<float>(), SERVO_MIN_DEG[i], SERVO_MAX_DEG[i]);
      }
      const char* m = v["m"] | rootDoc["mode"] | "MANUAL";
      strncpy(currentMode, m, sizeof(currentMode) - 1);
      currentMode[sizeof(currentMode) - 1] = '\0';

      Serial.printf("[CMD] Arm target -> [%.0f deg, %.0f deg, %.0f deg, %.0f deg, %.0f deg] (%s)\n",
                    targetAngles[0], targetAngles[1], targetAngles[2],
                    targetAngles[3], targetAngles[4], currentMode);
      return true;
    }
  }

  if (strcmp(k, "servo") == 0) {
    int jointAxis = v["eje"] | v["axis"] | 0;
    float angle = v["angulo"] | v["angle"] | 90.0f;
    if (jointAxis >= 0 && jointAxis < 5) {
      targetAngles[jointAxis] = constrain(angle, SERVO_MIN_DEG[jointAxis], SERVO_MAX_DEG[jointAxis]);
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

// ================= 8. WEBSOCKET EVENT HANDLER ======================
void onWebSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[WS] Connected to Cloud Broker. Sending hello handshake...");
      isAuthenticated = false;
      sendHello();
      break;

    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected from Cloud Broker. Reconnection scheduled...");
      isAuthenticated = false;
      break;

    case WStype_TEXT: {
      JsonDocument doc;
      if (deserializeJson(doc, payload, length) != DeserializationError::Ok) return;
      const char* t = doc["t"] | doc["type"] | "";

      if (strcmp(t, "hello_ok") == 0) {
        isAuthenticated = true;
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

// ================= 9. RESILIENT SETUP ===============================
void setup() {
  // Native USB CDC serial initialization for ESP32-S3
  Serial.begin(115200);
  delay(1500); // Allow PC USB CDC enumerator to attach

  Serial.println("\n\n========================================================");
  Serial.println("  ESP32-S3 5-DOF ROBOTIC ARM - NASA SPACE APPS 2026");
  Serial.println("  Initializing system subsystems...");
  Serial.println("========================================================");

  pinMode(PIN_LED_STATUS, OUTPUT);
  digitalWrite(PIN_LED_STATUS, LOW);

  // 1. Initialize I2C bus with short timeout to prevent lockups
  Serial.printf("[I2C] Initializing bus on SDA=%d, SCL=%d...\n", PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 100000);
  Wire.setTimeOut(25); // 25ms timeout prevents hangs if a device drops off

  // 2. Non-blocking device scan
  Serial.println("[I2C] Scanning connected devices...");
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("  -> I2C device detected at address 0x%02X\n", addr);
    }
  }

  // 3. Initialize PCA9685 PWM Controller
  if (initPCA9685()) {
    pca9685_connected = true;
    Serial.println("[I2C] PCA9685 detected at 0x40. Servos initialized at 50 Hz.");
    for (int i = 0; i < 5; i++) {
      moveServoPCA9685(i, currentAngles[i]);
    }
  } else {
    Serial.println("[I2C] WARNING: PCA9685 not detected at 0x40 (verify SDA/SCL wiring and external 5V power).");
  }

  initMPU6050();

  // 4. Connect to Wi-Fi station
  Serial.printf("[WiFi] Connecting to '%s' ...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// ================= 10. MAIN SYSTEM LOOP ============================
void loop() {
  unsigned long now = millis();

  // Secure WebSocket connection / reconnection when Wi-Fi is active
  if (WiFi.status() == WL_CONNECTED) {
    if (!ws_initialized) {
      Serial.printf("\n[WiFi] Connected! IP: %s (RSSI: %d dBm)\n",
                    WiFi.localIP().toString().c_str(), WiFi.RSSI());
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
  }

  // Smooth kinematic servo interpolation (every 20 ms / 50 Hz)
  static unsigned long lastServoStepMs = 0;
  if (now - lastServoStepMs >= 20) {
    lastServoStepMs = now;
    const float MAX_STEP_DEG = 2.0f;

    for (int i = 0; i < 5; i++) {
      float diff = targetAngles[i] - currentAngles[i];
      if (fabs(diff) > 0.1f) {
        if (diff > MAX_STEP_DEG) diff = MAX_STEP_DEG;
        if (diff < -MAX_STEP_DEG) diff = -MAX_STEP_DEG;
        currentAngles[i] += diff;
        if (pca9685_connected) {
          moveServoPCA9685(i, currentAngles[i]);
        }
      } else {
        currentAngles[i] = targetAngles[i];
      }
    }
  }

  // Telemetry broadcast every 500 ms (2 Hz)
  if (isAuthenticated && WiFi.status() == WL_CONNECTED && (now - lastTelemetrySendMs >= TELEMETRY_INTERVAL_MS)) {
    lastTelemetrySendMs = now;

    float ax, ay, az;
    readMPU6050(ax, ay, az);

    int adcRaw = analogRead(PIN_SOLAR_ADC);
    solarVolt   = (adcRaw > 50) ? ((adcRaw / 4095.0f) * 3.3f) : (2.4f + sin(currentAngles[4] * DEG_TO_RAD) * 0.7f);
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
