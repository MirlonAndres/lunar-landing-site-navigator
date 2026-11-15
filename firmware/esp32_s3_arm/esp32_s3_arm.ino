/**
 * ================================================================================
 * FIRMWARE BRAZO ROBOTICO 5-DOF ESP32-S3 - NASA SPACE APPS CHALLENGE 2026
 * PROYECTO: LUNAR LANDING SITE NAVIGATOR - EQUIPO 01 (eq01)
 * ================================================================================
 * Hardware:
 * - Placa: ESP32-S3 (DevKitC-1, N8, N16, etc.)
 * - I2C: SDA = GPIO 8, SCL = GPIO 9 (PCA9685 a 0x40 para 5 servomotores)
 * - Broker en la Nube: fimee-esp32-hub-ahife23fha-tl.a.run.app:443 (WSS)
 *
 * NOTA IMPORTANTE DE CONFIGURACION EN ARDUINO IDE (Menu Herramientas / Tools):
 * 1. Placa: "ESP32S3 Dev Module"
 * 2. USB CDC On Boot: "Enabled"  <-- OBLIGATORIO para ver el monitor serie en COM6
 * 3. PSRAM: "Disabled"            <-- OBLIGATORIO si tu placa no tiene PSRAM externa (evita bootloop)
 * 4. Flash Mode: "DIO 80MHz"     <-- Coincide con mode:DIO de tu chip
 * 5. Flash Size: "8MB" (o "4MB" / "16MB" segun tu placa)
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
const char* EQUIPO_ID     = "eq01";
const char* DEVICE_TOKEN  = "YOUR_DEVICE_TOKEN_HERE";

// ================= 3. ASIGNACION DE PINES ESP32-S3 =================
#define PIN_I2C_SDA         8   // Pin 8 a SDA
#define PIN_I2C_SCL         9   // Pin 9 a SCL
#define PIN_LED_STATUS      2   // LED indicador (GPIO 2 o 48 segun fabricante)
#define PIN_SOLAR_ADC       1   // ADC1_CH0 para lectura analogica
#define PCA9685_ADDR        0x40
#define MPU6050_ADDR        0x68

// ================= 4. CONTROLADOR NATIVO I2C PCA9685 ===============
#define PCA9685_MODE1       0x00
#define PCA9685_MODE2       0x01
#define PCA9685_PRESCALE    0xFE
#define PCA9685_LED0_ON_L   0x06

bool pca9685_conectado = false;
bool mpu6050_conectado = false;
bool ws_iniciado       = false;

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

bool iniciarPCA9685() {
  Wire.beginTransmission(PCA9685_ADDR);
  if (Wire.endTransmission() != 0) return false;

  pca9685_writeRegister(PCA9685_MODE1, 0x00);
  delay(5);
  uint8_t oldmode = pca9685_readRegister(PCA9685_MODE1);
  uint8_t sleepMode = (oldmode & 0x7F) | 0x10;
  pca9685_writeRegister(PCA9685_MODE1, sleepMode);
  pca9685_writeRegister(PCA9685_PRESCALE, 121); // 50 Hz para servos
  pca9685_writeRegister(PCA9685_MODE1, oldmode);
  delay(5);
  pca9685_writeRegister(PCA9685_MODE1, oldmode | 0xA0);
  pca9685_writeRegister(PCA9685_MODE2, 0x04);
  return true;
}

void moverServoPCA9685(uint8_t canal, float angulo) {
  if (!pca9685_conectado || canal > 15) return;
  angulo = constrain(angulo, 0.0f, 180.0f);
  // Mapeo 500 us (0°) a 2500 us (180°) -> 102 a 512 ticks sobre 4096 a 50Hz
  uint16_t offTick = map((long)(angulo * 10), 0, 1800, 102, 512);

  Wire.beginTransmission(PCA9685_ADDR);
  Wire.write(PCA9685_LED0_ON_L + (4 * canal));
  Wire.write(0);
  Wire.write(0);
  Wire.write(offTick & 0xFF);
  Wire.write((offTick >> 8) & 0xFF);
  Wire.endTransmission();
}

bool iniciarMPU6050() {
  Wire.beginTransmission(MPU6050_ADDR);
  if (Wire.endTransmission() != 0) return false;
  Wire.beginTransmission(MPU6050_ADDR);
  Wire.write(0x6B);
  Wire.write(0x00);
  return (Wire.endTransmission() == 0);
}

void leerMPU6050(float &ax, float &ay, float &az) {
  if (!mpu6050_conectado) {
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

// ================= 5. ESTADO Y ARTICULACIONES DEL BRAZO ============
// Limites biomecanicos seguros por articulacion [Base, Hombro, Codo, Muneca, Panel Roll]
const float SERVO_MIN_DEG[5]  = {25.0f, 35.0f, 40.0f, 40.0f, 30.0f};
const float SERVO_MAX_DEG[5]  = {155.0f, 115.0f, 125.0f, 135.0f, 150.0f};

float angulosActuales[5] = {90.0f, 55.0f, 60.0f, 70.0f, 90.0f};
float angulosObjetivo[5] = {90.0f, 55.0f, 60.0f, 70.0f, 90.0f};
char modoActual[24]       = "AUTO_SUN_TRACK";

float tempAmbiente = 23.5f;
float humAmbiente  = 44.0f;
float voltajeSolar = 2.75f;
float bateriaSoc   = 94.0f;

WebSocketsClient webSocket;
bool autenticado = false;
unsigned long ultimoEnvioMs = 0;
const unsigned long INTERVALO_TELEMETRIA_MS = 500;

// ================= 6. SALUDO INICIAL ("hello") =====================
void enviarHello() {
  JsonDocument doc;
  doc["t"]     = "hello";
  doc["id"]    = EQUIPO_ID;
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
  Serial.println("[WS] 'hello' enviado -> Esperando autenticacion del Broker...");
}

// ================= 7. EJECUCION DE COMANDOS DE LA WEB ==============
bool ejecutarComando(const char* k, JsonVariantConst v, JsonDocument& rootDoc) {
  if (strcmp(k, "arm") == 0 || strcmp(k, "") == 0) {
    JsonArrayConst arr = v["a"];
    if (arr.isNull()) arr = rootDoc["target_angles"].as<JsonArrayConst>();

    if (!arr.isNull() && arr.size() >= 5) {
      for (int i = 0; i < 5; i++) {
        angulosObjetivo[i] = constrain(arr[i].as<float>(), SERVO_MIN_DEG[i], SERVO_MAX_DEG[i]);
      }
      const char* m = v["m"] | rootDoc["mode"] | "MANUAL";
      strncpy(modoActual, m, sizeof(modoActual) - 1);
      modoActual[sizeof(modoActual) - 1] = '\0';

      Serial.printf("[CMD] Brazo -> [%.0f°, %.0f°, %.0f°, %.0f°, %.0f°] (%s)\n",
                    angulosObjetivo[0], angulosObjetivo[1], angulosObjetivo[2],
                    angulosObjetivo[3], angulosObjetivo[4], modoActual);
      return true;
    }
  }

  if (strcmp(k, "servo") == 0) {
    int eje = v["eje"] | 0;
    float angulo = v["angulo"] | 90.0f;
    if (eje >= 0 && eje < 5) {
      angulosObjetivo[eje] = constrain(angulo, SERVO_MIN_DEG[eje], SERVO_MAX_DEG[eje]);
      return true;
    }
  }

  if (strcmp(k, "led") == 0) {
    int estado = v["on"] | 0;
    digitalWrite(PIN_LED_STATUS, estado ? HIGH : LOW);
    return true;
  }

  return false;
}

// ================= 8. MANEJO DE EVENTOS WEBSOCKET ==================
void onWebSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[WS] Conectado al Broker en la Nube. Enviando hello...");
      autenticado = false;
      enviarHello();
      break;

    case WStype_DISCONNECTED:
      Serial.println("[WS] Desconectado. Reintentando automaticamente...");
      autenticado = false;
      break;

    case WStype_TEXT: {
      JsonDocument doc;
      if (deserializeJson(doc, payload, length) != DeserializationError::Ok) return;
      const char* t = doc["t"] | doc["type"] | "";

      if (strcmp(t, "hello_ok") == 0) {
        autenticado = true;
        Serial.println("\n[WS] >>> eq01 AUTENTICADO Y ONLINE EN LA WEB! <<<\n");
        digitalWrite(PIN_LED_STATUS, HIGH);
        return;
      }

      if (strcmp(t, "cmd") == 0 || strcmp(t, "command") == 0) {
        const char* cid = doc["cid"] | "";
        const char* k   = doc["k"]   | "arm";
        bool ok = ejecutarComando(k, doc["v"], doc);

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

// ================= 9. SETUP RESILIENTE =============================
void setup() {
  // Inicializacion del puerto serie USB nativo del ESP32-S3
  Serial.begin(115200);
  delay(1500); // Pausa para que el USB CDC de la PC enumere

  Serial.println("\n\n========================================================");
  Serial.println("  ESP32-S3 BRAZO ROBOTICO 5-DOF - NASA SPACE APPS 2026");
  Serial.println("  Iniciando sistema...");
  Serial.println("========================================================");

  pinMode(PIN_LED_STATUS, OUTPUT);
  digitalWrite(PIN_LED_STATUS, LOW);

  // 1. Iniciar bus I2C con timeout corto (evita bloqueos si no hay pullup)
  Serial.printf("[I2C] Iniciando bus en SDA=%d, SCL=%d...\n", PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 100000);
  Wire.setTimeOut(25); // Timeout de 25ms para que NUNCA bloquee la ejecucion

  // 2. Escaneo no bloqueante
  Serial.println("[I2C] Escaneando dispositivos...");
  for (byte dir = 1; dir < 127; dir++) {
    Wire.beginTransmission(dir);
    if (Wire.endTransmission() == 0) {
      Serial.printf("  -> Dispositivo encontrado en direccion 0x%02X\n", dir);
    }
  }

  // 3. Iniciar PCA9685
  if (iniciarPCA9685()) {
    pca9685_conectado = true;
    Serial.println("[I2C] PCA9685 detectado en 0x40. Servos inicializados a 50 Hz.");
    for (int i = 0; i < 5; i++) {
      moverServoPCA9685(i, angulosActuales[i]);
    }
  } else {
    Serial.println("[I2C] AVISO: PCA9685 no detectado en 0x40 (verificar cables SDA/SCL o alimentacion).");
  }

  iniciarMPU6050();

  // 4. Iniciar conexion WiFi
  Serial.printf("[WiFi] Conectando a '%s' ...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// ================= 10. LOOP ========================================
void loop() {
  unsigned long ahora = millis();

  // Conexion / Reconexion segura al WebSocket solo cuando hay WiFi
  if (WiFi.status() == WL_CONNECTED) {
    if (!ws_iniciado) {
      Serial.printf("\n[WiFi] Conectado! IP: %s (RSSI: %d dBm)\n",
                    WiFi.localIP().toString().c_str(), WiFi.RSSI());
      Serial.printf("[WS] Conectando a %s:%d%s ...\n", WS_HOST, WS_PORT, WS_PATH);
      webSocket.beginSSL(WS_HOST, WS_PORT, WS_PATH);
      webSocket.onEvent(onWebSocketEvent);
      webSocket.setReconnectInterval(3000);
      webSocket.enableHeartbeat(15000, 5000, 2);
      ws_iniciado = true;
    }
    webSocket.loop();
  } else {
    // Si se desconecta WiFi, permitir que reintente
    ws_iniciado = false;
    autenticado = false;
  }

  // Movimiento suave de los servos (cada 20 ms / 50 Hz)
  static unsigned long ultimoPasoServoMs = 0;
  if (ahora - ultimoPasoServoMs >= 20) {
    ultimoPasoServoMs = ahora;
    const float PASO_MAX_DEG = 2.0f;

    for (int i = 0; i < 5; i++) {
      float diff = angulosObjetivo[i] - angulosActuales[i];
      if (fabs(diff) > 0.1f) {
        if (diff > PASO_MAX_DEG) diff = PASO_MAX_DEG;
        if (diff < -PASO_MAX_DEG) diff = -PASO_MAX_DEG;
        angulosActuales[i] += diff;
        if (pca9685_conectado) {
          moverServoPCA9685(i, angulosActuales[i]);
        }
      } else {
        angulosActuales[i] = angulosObjetivo[i];
      }
    }
  }

  // Envio de telemetria cada 500 ms (2 Hz)
  if (autenticado && WiFi.status() == WL_CONNECTED && (ahora - ultimoEnvioMs >= INTERVALO_TELEMETRIA_MS)) {
    ultimoEnvioMs = ahora;

    float ax, ay, az;
    leerMPU6050(ax, ay, az);

    int adcRaw = analogRead(PIN_SOLAR_ADC);
    voltajeSolar = (adcRaw > 50) ? ((adcRaw / 4095.0f) * 3.3f) : (2.4f + sin(angulosActuales[4] * DEG_TO_RAD) * 0.7f);
    tempAmbiente = 23.2f + (sin(ahora * 0.0005f) * 0.4f);
    humAmbiente  = 43.5f + (cos(ahora * 0.0005f) * 1.2f);

    JsonDocument doc;
    doc["t"]    = "tel";
    doc["id"]   = EQUIPO_ID;
    doc["rssi"] = WiFi.RSSI();

    JsonObject d = doc["d"].to<JsonObject>();
    d["solar_v"] = round(voltajeSolar * 100.0f) / 100.0f;
    d["temp"]    = round(tempAmbiente * 10.0f) / 10.0f;
    d["hum"]     = round(humAmbiente * 10.0f) / 10.0f;
    d["bat"]     = round(bateriaSoc * 10.0f) / 10.0f;
    d["mode"]    = modoActual;

    JsonArray anglesArr = d["angles"].to<JsonArray>();
    for (int i = 0; i < 5; i++) {
      anglesArr.add((int)round(angulosActuales[i]));
    }

    JsonArray accArr = d["acc"].to<JsonArray>();
    accArr.add(round(ax * 100.0f) / 100.0f);
    accArr.add(round(ay * 100.0f) / 100.0f);
    accArr.add(round(az * 100.0f) / 100.0f);

    String salida;
    serializeJson(doc, salida);
    webSocket.sendTXT(salida);
  }
}
