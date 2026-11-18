/**
 * Telemetry and Real-Time Hardware Relay Client
 * Cliente de Telemetria y Retransmision de Hardware en Tiempo Real
 * NASA Space Apps Challenge 2026 - Lunar Landing Site Navigator
 *
 * English:
 * Manages the WebSocket connection to the FastAPI backend, reports true ESP32
 * hardware presence (with 10 s staleness detection), and throttles outbound 5-DOF
 * servo commands to <= 16 Hz with trailing-edge flush so slider dragging stays smooth.
 *
 * Espanol:
 * Administra la conexion WebSocket con el servidor FastAPI, informa la presencia
 * real del ESP32 (con caducidad a los 10 s) y limita el envio de comandos de los 5
 * servos a <= 16 Hz con envio final garantizado para un arrastre fluido.
 */

class TelemetryClient {
  constructor(options = {}) {
    this.onTelemetry = options.onTelemetry || null;
    this.onLinkStatus = options.onLinkStatus || null;

    this.ws = null;
    this.wsOpen = false;
    this.reconnectTimer = null;

    // Last real hardware telemetry received / Ultima telemetria real recibida
    this.latestTelemetry = {
      angles: [90, 55, 60, 70, 90],
      dht22_temp_c: null,
      dht22_humidity_pct: null,
      solar_voltage_v: null,
      battery_soc_pct: null,
      mode: "MANUAL",
      source: null
    };

    // Real ESP32 link status from server / Estado real del ESP32 desde el servidor
    this.linkStatus = {
      esp32_state: "OFFLINE",
      esp32_online: false,
      data_fresh: false,
      last_packet_age_s: null,
      path: null,
      cloud_connected: false,
      rssi_dbm: null,
      cmd_latency_ms: null
    };

    // 60 ms command throttle state / Limitador de comandos a 60 ms
    this._throttleMs = 60;
    this._lastSentAt = 0;
    this._pendingCmd = null;
    this._flushTimer = null;

    this.connect();
  }

  connect() {
    const loc = window.location;
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    const host = loc.host || "localhost:8000";
    const url = `${proto}//${host}/ws/teleop?client_type=dashboard`;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.wsOpen = true;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          this._handleMessage(msg);
        } catch (err) {
          console.warn("[Telemetry] Parse error:", err);
        }
      };

      this.ws.onclose = () => {
        this.wsOpen = false;
        this.linkStatus.esp32_state = "OFFLINE";
        if (this.onLinkStatus) this.onLinkStatus(this.linkStatus);
        this._scheduleReconnect();
      };

      this.ws.onerror = () => {
        try { this.ws.close(); } catch (_) {}
      };
    } catch (_) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 2500);
    }
  }

  _handleMessage(msg) {
    if (msg.type === "state_snapshot") {
      if (msg.telemetry) Object.assign(this.latestTelemetry, msg.telemetry);
      if (msg.link) Object.assign(this.linkStatus, msg.link);
      if (this.onLinkStatus) this.onLinkStatus(this.linkStatus);
      if (this.onTelemetry) this.onTelemetry(this.latestTelemetry);
      return;
    }

    if (msg.type === "telemetry_stream" && msg.data) {
      Object.assign(this.latestTelemetry, msg.data);
      if (this.onTelemetry) this.onTelemetry(this.latestTelemetry);
      return;
    }

    if (msg.type === "link_status" && msg.data) {
      Object.assign(this.linkStatus, msg.data);
      if (this.onLinkStatus) this.onLinkStatus(this.linkStatus);
    }
  }

  /**
   * Throttled dispatch of servo angles (at most once per 60 ms + trailing flush).
   * Applies live 180-deg servo calibration (trim offset & direction invert) and maps
   * the 4th physical axis (Panel Roll 0-180) to both index 3 and index 4 (PCA9685 CH3 & CH4).
   */
  sendArmCommand(angles, mode = "MANUAL") {
    const limits = [[0, 180], [0, 180], [20, 160], [0, 180], [0, 180]];
    let trim = [0, 0, 0, 0, 0];
    let dir = [1, 1, 1, 1, 1];
    try {
      const saved = JSON.parse(localStorage.getItem("esp32_servo_cal") || "null");
      if (saved && Array.isArray(saved.trim) && Array.isArray(saved.dir)) {
        trim = saved.trim.map((n) => Number(n) || 0);
        dir = saved.dir.map((n) => (Number(n) < 0 ? -1 : 1));
      }
    } catch (_) {}

    const clean = angles.map((a, i) => {
      const [minA, maxA] = limits[i] || [0, 180];
      let val = Number(a);
      if (Number.isNaN(val)) val = 90;
      // Apply direction inversion (180 - angle) and trim offset
      const oriented = dir[i] < 0 ? (180 - val) : val;
      const calibrated = oriented + (trim[i] || 0);
      return Math.max(minA, Math.min(maxA, Math.round(calibrated)));
    });
    // Physical arm has 4 servos: Base (CH0), Shoulder (CH1), Elbow (CH2), and Panel Roll (CH3/CH4)
    clean[3] = clean[4];

    this._pendingCmd = { type: "command", target_angles: clean, mode };

    const now = performance.now();
    const elapsed = now - this._lastSentAt;

    if (elapsed >= this._throttleMs) {
      this._flushNow();
    } else if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        this._flushNow();
      }, this._throttleMs - elapsed);
    }
  }

  _flushNow() {
    if (!this._pendingCmd) return;
    const payload = this._pendingCmd;
    this._pendingCmd = null;
    this._lastSentAt = performance.now();

    if (this.wsOpen && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (_) {}
    }
  }
}

window.TelemetryClient = TelemetryClient;
