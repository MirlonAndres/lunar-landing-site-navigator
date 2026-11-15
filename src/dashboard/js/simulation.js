/**
 * 20-Second Accelerated 7-Day Lunar Mission Simulation Engine
 * Motor de Simulacion de Mision Lunar Acelerada: 7 Dias en 20 Segundos
 * NASA Space Apps Challenge 2026 - Lunar Landing Site Navigator
 */

class MissionSimulationEngine {
  constructor(options = {}) {
    this.totalDurationSec = 20.0;
    this.currentTimeSec = 10.0; // Start at Day 4.0 (sunlit phase) / Inicia en Dia 4.0 (fase iluminada)
    this.isPlaying = false;
    this.rafId = null;
    this.lastTs = null;

    this.trajectory = [];
    this.summary = null;

    this.onTick = options.onTick || null;
    this.onStateChange = options.onStateChange || null;
  }

  setTimelineData(data) {
    this.summary = data.summary || {};
    this.trajectory = data.sample_trajectory || [];
    this.updateFrame();
  }

  play() {
    if (this.isPlaying) return;
    if (this.currentTimeSec >= this.totalDurationSec - 0.05) {
      this.currentTimeSec = 0;
    }
    this.isPlaying = true;
    this.lastTs = performance.now();
    if (this.onStateChange) this.onStateChange(true);
    this._loop();
  }

  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.onStateChange) this.onStateChange(false);
  }

  togglePlay() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  seek(sec) {
    this.currentTimeSec = Math.max(0, Math.min(this.totalDurationSec, Number(sec) || 0));
    this.updateFrame();
  }

  _loop() {
    if (!this.isPlaying) return;
    const now = performance.now();
    const dt = (now - this.lastTs) / 1000.0;
    this.lastTs = now;

    this.currentTimeSec += dt;
    if (this.currentTimeSec >= this.totalDurationSec) {
      this.currentTimeSec = this.currentTimeSec % this.totalDurationSec;
    }

    this.updateFrame();
    this.rafId = requestAnimationFrame(() => this._loop());
  }

  updateFrame() {
    if (!this.trajectory.length) return;

    const progress = this.currentTimeSec / this.totalDurationSec;
    const maxIdx = this.trajectory.length - 1;
    const exact = progress * maxIdx;
    const i0 = Math.floor(exact);
    const i1 = Math.min(maxIdx, i0 + 1);
    const f = exact - i0;

    const a = this.trajectory[i0];
    const b = this.trajectory[i1];

    const lerp = (x, y) => x + (y - x) * f;

    const sunElev = lerp(a.sun_elev, b.sun_elev);
    const sunAz = a.sun_az !== undefined ? lerp(a.sun_az, b.sun_az) : (218 - progress * 85 + 360) % 360;
    const trackingW = lerp(a.power_tracking_w, b.power_tracking_w);
    const fixedW = lerp(a.power_fixed_w, b.power_fixed_w);
    const batterySoc = lerp(a.battery_soc_pct, b.battery_soc_pct);
    const sunVisible = trackingW > 5.0;
    const heatersActive = a.heaters_active !== undefined ? a.heaters_active : !sunVisible;
    const dteVisible = Boolean(a.dte_visible);

    const totalTrackWh = (this.summary && this.summary.tracking_panel_energy_wh) || 15794.5;
    const totalFixedWh = (this.summary && this.summary.fixed_panel_energy_wh) || 315.3;

    const frame = {
      currentTimeSec: this.currentTimeSec,
      totalDurationSec: this.totalDurationSec,
      progress,
      day: 1.0 + progress * 6.0,
      hour: progress * 168.0,
      sunAz,
      sunElev,
      sunVisible,
      trackingW,
      fixedW,
      cumTrackingWh: Math.round(totalTrackWh * Math.max(0.08, progress)),
      cumFixedWh: Math.round(totalFixedWh * Math.max(0.08, progress)),
      batterySoc,
      heatersActive,
      dteVisible
    };

    if (this.onTick) this.onTick(frame);
  }
}

window.MissionSimulationEngine = MissionSimulationEngine;
