/**
 * Hardware Configuration and Pin Assignments
 * NASA Space Apps Challenge 2026 - Team 01 (eq01)
 * 
 * Central configuration header for 5-DOF robotic arm, physical sensors,
 * and dual WiFi/WebSocket network connection.
 */

#pragma once

#include <Arduino.h>

// ==============================================================================
// 1. PIN DEFINITIONS
// ==============================================================================

// I2C Bus Pins (ESP32-S3 default hardware I2C)
// Connected to PCA9685 PWM Controller and MPU6050 IMU
#define PIN_I2C_SDA             8   // GPIO 8 - Serial Data (SDA)
#define PIN_I2C_SCL             9   // GPIO 9 - Serial Clock (SCL)
#define PCA9685_I2C_ADDR        0x40

// DHT22 (AM2302) Temperature and Humidity Sensor
#define PIN_DHT22_DATA          4

// Solar Panel ADC Analog Sensing Pin
// ESP32-S3 uses GPIO 1 (ADC1_CH0) | ESP32 DevKit uses GPIO 34 (ADC1_CH6)
#if defined(CONFIG_IDF_TARGET_ESP32S3)
    #define PIN_SOLAR_PANEL_ADC 1
#else
    #define PIN_SOLAR_PANEL_ADC 34
#endif

// 5-DOF Robotic Arm PWM Servo Channels on PCA9685
#define CHANNEL_SERVO_BASE      0   // Joint 0: Base Turntable (Yaw)
#define CHANNEL_SERVO_SHOULDER  1   // Joint 1: Shoulder (Pitch)
#define CHANNEL_SERVO_ELBOW     2   // Joint 2: Elbow (Pitch)
#define CHANNEL_SERVO_WRIST     3   // Joint 3: Wrist (Pitch)
#define CHANNEL_SERVO_PANEL     4   // Joint 4: Solar Panel Roll

// ==============================================================================
// 2. NETWORK CREDENTIALS & BROKER ENDPOINTS
// ==============================================================================

// WiFi Credentials (Replace with local 2.4 GHz network or mobile hotspot)
#define WIFI_SSID_DEFAULT       "YOUR_WIFI_SSID_2_4GHZ"
#define WIFI_PASS_DEFAULT       "YOUR_WIFI_PASSWORD"

// Cloud IoT Broker Endpoints & Tokens (Configurable via environment variables)
#define CLOUD_HOST              "fimee-esp32-hub-ahife23fha-tl.a.run.app"
#define CLOUD_PORT              443
#define CLOUD_WS_PATH           "/ws"
#define HACKATHON_TEAM_ID       "eq01"
#define HACKATHON_DEVICE_TOKEN  "YOUR_DEVICE_TOKEN_HERE"
#define HACKATHON_WEB_KEY       "YOUR_WEB_KEY_HERE"

// Local Relay Fallback (For direct low-latency LAN communication)
#define LOCAL_RELAY_PORT        8000
#define LOCAL_WS_PATH           "/ws/teleop?client_type=hardware"

// ==============================================================================
// 3. CALIBRATION CONSTANTS
// ==============================================================================

// ADC Voltage Divider Calibration Factor
#define ADC_VOLTAGE_REF         3.3f
#define ADC_MAX_RESOLUTION      4095.0f
#define VOLTAGE_DIVIDER_RATIO   1.0f    // Resistor divider calibration ratio R1/(R1+R2)

// Anatomical Servo Limits (Degrees)
#define SERVO_MIN_DEG           25
#define SERVO_MAX_DEG           155
#define SERVO_HOME_BASE         90
#define SERVO_HOME_SHOULDER     55
#define SERVO_HOME_ELBOW        60
#define SERVO_HOME_WRIST        70
#define SERVO_HOME_PANEL        90

// Telemetry Transmit Rate (Hz)
#define TELEMETRY_INTERVAL_MS    500     // 2 Hz transmission rate (500 ms)
#define DHT22_SAMPLE_INTERVAL_MS 2000    // Sample DHT22 every 2 seconds
