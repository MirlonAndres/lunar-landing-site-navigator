/**
 * Hardware Configuration and Pin Assignments
 * Configuracion de Hardware y Asignacion de Pines
 * NASA Space Apps Challenge 2026 - Equipo 01 (eq01)
 * 
 * English:
 * Central configuration header for 5-DOF robotic arm, physical sensors,
 * and dual WiFi/WebSocket network connection.
 * 
 * Espanol:
 * Encabezado de configuracion central para brazo robotico de 5 ejes, sensores fisicos
 * y conexion de red dual WiFi/WebSocket.
 */

#pragma once

#include <Arduino.h>

// ==============================================================================
// 1. PIN DEFINITIONS / DEFINICION DE PINES
// ==============================================================================

// I2C Bus Pins (ESP32-S3 default hardware I2C)
// Pines de Bus I2C para Modulo PCA9685 y Sensores IMU/MPU6050
#define PIN_I2C_SDA             8   // GPIO 8 - Data (SDA)
#define PIN_I2C_SCL             9   // GPIO 9 - Clock (SCL)
#define PCA9685_I2C_ADDR        0x40

// DHT22 (AM2302) Temperature and Humidity Sensor
// Sensor de temperatura y humedad DHT22
#define PIN_DHT22_DATA          4

// Solar Panel ADC Analog Sensing Pin
// ESP32-S3 uses GPIO 1 (ADC1_CH0) | ESP32 DevKit uses GPIO 34 (ADC1_CH6)
#if defined(CONFIG_IDF_TARGET_ESP32S3)
    #define PIN_SOLAR_PANEL_ADC 1
#else
    #define PIN_SOLAR_PANEL_ADC 34
#endif

// 5-DOF Robotic Arm PWM Servo Pins
// Pines PWM de los 5 servomotores del brazo robotico
#define PIN_SERVO_BASE          13  // Joint 1: Base Turntable (Yaw) / Giro de Base
#define PIN_SERVO_SHOULDER      14  // Joint 2: Shoulder (Pitch) / Hombro
#define PIN_SERVO_ELBOW         15  // Joint 3: Elbow (Pitch) / Codo
#define PIN_SERVO_WRIST         16  // Joint 4: Wrist (Pitch) / Muneca
#define PIN_SERVO_PANEL         17  // Joint 5: Solar Panel Orientation / Orientacion Panel

// ==============================================================================
// 2. NETWORK CREDENTIALS & BROKER ENDPOINTS / CREDENCIALES DE RED Y BROKER
// ==============================================================================

// WiFi Credentials (Replace with local network or hotspot)
// Credenciales WiFi (Reemplazar con red local o punto de acceso)
#define WIFI_SSID_DEFAULT       "NASA_HACKATHON_WIFI"
#define WIFI_PASS_DEFAULT       "Artemis2026"

// Cloud IoT Broker Endpoints & Tokens (Configurable / Placeholders)
#define CLOUD_HOST              "fimee-esp32-hub-ahife23fha-tl.a.run.app"
#define CLOUD_PORT              443
#define CLOUD_WS_PATH           "/ws"
#define HACKATHON_EQUIPO_ID     "eq01"
#define HACKATHON_DEVICE_TOKEN  "YOUR_DEVICE_TOKEN_HERE"
#define HACKATHON_WEB_KEY       "YOUR_WEB_KEY_HERE"

// Local Relay Fallback (For direct low-latency LAN communication)
// Respaldo de retransmision local (Para comunicacion directa de baja latencia por LAN)
#define LOCAL_RELAY_PORT        8000
#define LOCAL_WS_PATH           "/ws/teleop?client_type=hardware"

// ==============================================================================
// 3. CALIBRATION CONSTANTS / CONSTANTES DE CALIBRACION
// ==============================================================================

// ADC Voltage Divider Calibration Factor
// Factor de calibracion del divisor de tension ADC (panel solar 0-5V -> 0-3.3V)
#define ADC_VOLTAGE_REF         3.3f
#define ADC_MAX_RESOLUTION      4095.0f
#define VOLTAGE_DIVIDER_RATIO   1.0f    // Set according to resistor divider R1/(R1+R2)

// Servo Motion Limits (Degrees) / Limites de movimiento de servos (Grados)
#define SERVO_MIN_DEG           0
#define SERVO_MAX_DEG           180
#define SERVO_HOME_BASE         90
#define SERVO_HOME_SHOULDER     45
#define SERVO_HOME_ELBOW        120
#define SERVO_HOME_WRIST        60
#define SERVO_HOME_PANEL        30

// Telemetry Transmit Rate (Hz) / Tasa de envio de telemetria (Hz)
#define TELEMETRY_INTERVAL_MS   500     // 2 Hz transmission / Envio cada 500 ms
#define DHT22_SAMPLE_INTERVAL_MS 2000   // Sample DHT22 every 2 seconds / Lectura cada 2s
