/**
 * Telemetry and Real-Time Hardware Relay Client
 * NASA Space Apps Challenge 2026 - Lunar Landing Site Navigator
 *
 * Manages the WebSocket connection to the FastAPI backend, reports true ESP32
 * hardware presence (with 10 s staleness detection), and throttles outbound 5-DOF
 * servo commands to <= 16 Hz with trailing-edge flush so slider dragging stays smooth.
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
   * Throttled dispatch of 5-DOF servo angles (at most once per 60 ms + trailing flush).
   * Envio regulado de los 5 angulos de servo (maximo una vez cada 60 ms + envio final).
   */
  sendArmCommand(angles, mode = "MANUAL") {
    const limits = [[25, 155], [35, 115], [40, 125], [40, 135], [30, 150]];
    const clean = angles.map((a, i) => {
      const [minA, maxA] = limits[i] || [0, 180];
      return Math.max(minA, Math.min(maxA, Math.round(Number(a) || 90)));
    });
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
