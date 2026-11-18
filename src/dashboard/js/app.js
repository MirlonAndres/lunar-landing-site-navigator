/**
 * Lunar Landing Site Navigator - Master Application Controller
 * Controlador Maestro de Aplicacion - Globo Lunar 3D, Terreno LOLA y Brazo 5-DOF
 * NASA Space Apps Challenge 2026 - Equipo 01 (eq01)
 */

document.addEventListener("DOMContentLoaded", async () => {
  const $ = (id) => document.getElementById(id);

  // Loader
  const loader = $("loader");
  const loaderText = $("loader-text");
  const loaderBar = $("loader-bar");
  const toastEl = $("toast");

  // Header controls
  const btnModeLive = $("mode-live");
  const btnModeDemo = $("mode-demo");
  const modeLiveDot = $("mode-live-dot");
  const espPill = $("esp-pill");
  const espDot = $("esp-dot");
  const espText = $("esp-text");
  const espSub = $("esp-sub");
  const btnViewToggle = $("btn-view-toggle");
  const viewToggleLabel = $("view-toggle-label");
  const btnResetCam = $("btn-reset-cam");
  const btnExportReport = $("btn-export-report");
  const btnStartTour = $("btn-start-tour");

  // Mission Tour elements (Point 1)
  const tourBackdrop = $("tour-backdrop");
  const tourCard = $("tour-card");
  const tourBtnClose = $("tour-btn-close");
  const tourBtnSkip = $("tour-btn-skip");
  const tourBtnPrev = $("tour-btn-prev");
  const tourBtnNext = $("tour-btn-next");
  const tourProgressBar = $("tour-progress-bar");
  const tourStepTag = $("tour-step-tag");
  const tourStepTitle = $("tour-step-title");
  const tourStepDesc = $("tour-step-desc");
  const tourCallout = $("tour-callout");

  // Globe hero & surface layer bar
  const globeHero = $("globe-hero");
  const heroTitle = $("hero-title");
  const heroDesc = $("hero-desc");
  const btnDescend = $("btn-descend");
  const layerbar = $("layerbar");
  const layerLegend = $("layer-legend");
  const btnToggleZones = $("btn-toggle-zones");

  // Panels
  const panelLeft = $("panel-left");
  const panelRight = $("panel-right");
  const collapseLeft = $("collapse-left");
  const collapseRight = $("collapse-right");
  const sitesList = $("sites-list");
  const zonesList = $("zones-list");
  const rightSubtitle = $("right-subtitle");

  // Arm controls
  const btnArmManual = $("arm-mode-manual");
  const btnArmAuto = $("arm-mode-auto");
  const sliders = [0, 1, 2, 3, 4].map((i) => $(`j${i}`));
  const sliderLabels = [0, 1, 2, 3, 4].map((i) => $(`lbl-j${i}`));
  const presetButtons = Array.from(document.querySelectorAll("[data-preset]"));

  // Sensor cards
  const sensorNotice = $("sensor-notice");
  const solarBadge = $("solar-badge");
  const valSolar = $("val-solar");
  const barSolar = $("bar-solar");
  const valTemp = $("val-temp");
  const barTemp = $("bar-temp");
  const valHum = $("val-hum");
  const barHum = $("bar-hum");

  // Mission timeline bar
  const btnPlay = $("btn-play");
  const iconPlay = $("icon-play");
  const iconPause = $("icon-pause");
  const tlTitle = $("tl-title");
  const tlSub = $("tl-sub");
  const tlScrub = $("tl-scrub");
  const tlSunBands = $("tl-sun-bands");
  const tlDteBands = $("tl-dte-bands");
  const kpiWh = $("kpi-wh");
  const kpiSoc = $("kpi-soc");
  const kpiHeater = $("kpi-heater");
  const kpiDte = $("kpi-dte");

  // State & Static Catalogs
  const SITE_SUMMARIES = [
    "Illuminated ridge adjacent to Shackleton Crater; ideal balance between continuous sun and level terrain.",
    "High polar peak with near-continuous solar exposure during the orbital illumination cycle.",
    "Elevated massif (+4,980 m) with direct, unobstructed line of sight to Earth for telecom.",
    "Cryogenic crater rim harboring substantial water-ice reserves in permanent shadow."
  ];

  const JOINT_LIMITS = [
    [25, 155], // 1. Base Turntable
    [35, 110], // 2. Shoulder Pitch
    [40, 120], // 3. Elbow Flexion
    [45, 130], // 4. Wrist Tilt (panel clearance)
    [35, 145]  // 5. Panel Roll (panel corner clearance)
  ];

  const PRESETS = {
    home:   { angles: [90, 55, 60, 70, 90],  label: "Arm balanced home position (180° calibrated)" },
    sample: { angles: [90, 82, 78, 95, 90],  label: "Lunar regolith sampling (panel clearance guarded)" },
    stow:   { angles: [90, 42, 52, 60, 90],  label: "Arm stowed (lunar night hibernation)" },
    dust:   { angles: [90, 68, 72, 105, 90], label: "Electrostatic dust-shedding routine (regolith clearing)" }
  };

  let appMode = "LIVE";     // "LIVE" | "DEMO" (starts in LIVE hardware streaming mode)
  let armMode = "AUTO";     // Start in AUTO sun-tracking; switches to MANUAL when sliders move
  let sites = [];
  let zones = [];
  let selectedSiteIdx = 0;
  let lastFrame = null;
  let toastTimer = null;
  let lastLocalCommandMs = 0;

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2400);
  }

  function activateTab(tabName) {
    panelRight.classList.remove("collapsed");
    panelRight.querySelectorAll("[data-tab]").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-tab") === tabName);
      b.setAttribute("aria-selected", String(b.getAttribute("data-tab") === tabName));
    });
    $("tab-control").classList.toggle("active", tabName === "control");
    $("tab-sensors").classList.toggle("active", tabName === "sensors");
  }

  function highlightPreset(key) {
    presetButtons.forEach((b) => b.classList.toggle("active", b.getAttribute("data-preset") === key));
  }

  // 1. Initialize 3D Globe-to-Site Engine
  loaderBar.style.width = "20%";
  const twin = new LunarDigitalTwin("viewport", "labels");

  // 2. Initialize Telemetry Client
  const telemetry = new TelemetryClient({
    onLinkStatus: (link) => renderLinkStatus(link),
    onTelemetry: (data) => {
      if (appMode === "LIVE") {
        renderLiveSensors(data);
        // Bidirectional Mirror Sync: when ESP32 reports calibrated/actual angles and user isn't actively dragging a slider, mirror 1:1
        if (
          Array.isArray(data.angles) &&
          data.angles.length === 5 &&
          performance.now() - lastLocalCommandMs > 1400 &&
          !twin._dustRoutineActive
        ) {
          const synced = twin.clampArmAngles(data.angles);
          setSlidersUI(synced);
          twin.updateArmJoints(synced);
        }
      }
    }
  });

  // 3. Initialize 20-Second Mission Simulation Engine
  const sim = new MissionSimulationEngine({
    onTick: (frame) => {
      lastFrame = frame;
      renderTimelineFrame(frame);
    },
    onStateChange: (playing) => {
      iconPlay.classList.toggle("hide", playing);
      iconPause.classList.toggle("hide", !playing);
    }
  });

  // 4. Load Backend Datasets
  try {
    loaderText.textContent = "Cargando topografía LOLA y mapa de iluminación polar...";
    loaderBar.style.width = "45%";

    const [meshRes, illumRes, sitesRes, zonesRes, tlRes] = await Promise.all([
      fetch("/api/terrain/mesh"),
      fetch("/api/terrain/illumination"),
      fetch("/api/portfolio/sites"),
      fetch("/api/landing-zones"),
      fetch("/api/mission/timeline")
    ]);

    const meshData = meshRes.ok ? await meshRes.json() : null;
    const illumData = illumRes.ok ? await illumRes.json() : null;
    loaderBar.style.width = "75%";

    if (meshData) {
      twin.loadTerrainMesh(meshData, illumData);
    }

    if (sitesRes.ok) {
      const sj = await sitesRes.json();
      sites = sj.sites || [];
      renderSites(sites);
      twin.setGlobeSites(sites, (idx, descend) => selectSite(idx, descend));
    }

    if (zonesRes.ok) {
      const zj = await zonesRes.json();
      zones = zj.optimal_footprints || [];
      twin.renderLandingZones(zones);
      renderZones(zones);
    }

    if (tlRes.ok) {
      const tj = await tlRes.json();
      buildTimelineBands(tj.sample_trajectory || []);
      sim.setTimelineData(tj);
      if (appMode === "DEMO") {
        sim.play();
      }
    }

    loaderBar.style.width = "100%";
  } catch (err) {
    console.error("[App] Data load error:", err);
  } finally {
    setTimeout(() => {
      loader.style.opacity = "0";
      setTimeout(() => loader.classList.add("hide"), 600);
    }, 250);
  }

  // ============================================================================
  // UI RENDERERS
  // ============================================================================

  function renderSites(list) {
    sitesList.innerHTML = "";
    list.forEach((s, idx) => {
      const card = document.createElement("div");
      card.className = `site-card ${idx === selectedSiteIdx ? "active" : ""}`;
      card.style.cursor = "pointer";
      const shortName = (s.name_en || s.name_es).split("(")[0].trim();
      const score = Math.round(s.landing_suitability_score);
      const sunPct = Math.round(s.sun_illumination_pct);

      card.innerHTML = `
        <div class="site-card-top">
          <div>
            <div class="site-name">${idx + 1}. ${shortName}</div>
            <div class="site-tag">${SITE_SUMMARIES[idx] || ""}</div>
          </div>
          <div class="site-score">${sunPct}%<small>Sunlight</small></div>
        </div>
        <div class="bar"><i style="width:${Math.min(100, Math.max(15, sunPct))}%"></i></div>
        <div class="site-details">
          <div class="metric"><label>Elevation</label><b>${s.elevation_m >= 0 ? "+" : ""}${Math.round(s.elevation_m)} m</b></div>
          <div class="metric"><label>Mean slope</label><b>${s.mean_slope_deg.toFixed(1)}°</b></div>
          <div class="metric"><label>Temperature</label><b>${Math.round(s.diviner_surface_temp_k)} K</b></div>
          <div class="metric"><label>Composite score</label><b>${score} / 100</b></div>
          <div class="site-cta">
            <button class="btn primary block" data-explore="${idx}">
              Explore 3D Terrain
            </button>
          </div>
        </div>
      `;

      card.addEventListener("click", (ev) => {
        const exploreBtn = ev.target.closest("[data-explore]");
        const wasActive = idx === selectedSiteIdx;
        selectSite(idx, Boolean(exploreBtn) || wasActive || twin.viewMode === "surface");
      });

      sitesList.appendChild(card);
    });
  }

  function setActiveZoneUI(activeRank) {
    zonesList.querySelectorAll(".zone-row").forEach((row) => {
      const r = Number(row.getAttribute("data-zone-rank"));
      const isMatch = r === activeRank;
      row.classList.toggle("active", isMatch);
      const titleEl = row.querySelector(".zone-title-text");
      if (titleEl) {
        titleEl.textContent = `Safe Zone #${r}${isMatch ? " · Lander & arm" : ""}`;
      }
    });
  }

  function selectSite(idx, descendToSurface = false) {
    selectedSiteIdx = idx;
    const cards = sitesList.querySelectorAll(".site-card");
    cards.forEach((c, i) => c.classList.toggle("active", i === idx));
    twin.highlightGlobeSite(idx);

    const s = sites[idx];
    const shortName = s ? (s.name_en || s.name_es).split("(")[0].trim() : `Site ${idx + 1}`;
    if (s) {
      heroTitle.textContent = `${shortName} · ${Math.round(s.sun_illumination_pct)}% solar illumination`;
      heroDesc.textContent = SITE_SUMMARIES[idx] || "";
    }

    if (descendToSurface) {
      enterSurfaceView(() => {
        twin.focusOnCandidateSite(idx);
        setActiveZoneUI(idx === 0 ? 1 : null);
        showToast(`Lander and solar panel relocated to: ${shortName}`);
      });
    } else {
      showToast(`Selected site: ${shortName}`);
    }
  }

  function renderZones(list) {
    zonesList.innerHTML = "";
    list.forEach((z, idx) => {
      const btn = document.createElement("button");
      btn.className = `zone-row ${idx === 0 ? "active" : ""}`;
      btn.setAttribute("data-zone-rank", String(z.rank));
      const psrKm = z.proximity_to_psr_km !== undefined ? z.proximity_to_psr_km.toFixed(1) : "2.6";
      btn.innerHTML = `
        <div class="zone-rank">${z.rank}</div>
        <div class="zone-main">
          <b class="zone-title-text">Safe Zone #${z.rank}${z.rank === 1 ? " · Lander & arm" : ""}</b>
          <div class="zone-meta-row">
            <span>Slope ${z.max_slope_deg.toFixed(1)}° · Elev. +${Math.round(z.elevation_m)} m</span>
            <span class="ice-tag" title="Distance to cryogenic water-ice reserve (Permanently Shadowed Region < 110 K)">
              <i class="ice-dot"></i>${psrKm} km to Ice
            </span>
          </div>
        </div>
        <div class="zone-score">${z.composite_safety_score.toFixed(1)}</div>
      `;
      btn.addEventListener("click", () => {
        setActiveZoneUI(z.rank);
        enterSurfaceView(() => {
          twin.focusOnZone(z);
          showToast(`Safe Zone #${z.rank}: Slope ${z.max_slope_deg.toFixed(1)}° · ${psrKm} km to Water Ice`);
        });
      });
      zonesList.appendChild(btn);
    });
  }

  twin.onSurfacePointSelect = (evt) => {
    if (evt.type === "zone" && evt.zone) {
      setActiveZoneUI(evt.zone.rank);
      showToast(`Lander and solar panel relocated to Safe Zone #${evt.zone.rank}`);
    } else if (evt.type === "terrain" && evt.point) {
      setActiveZoneUI(null);
      showToast("Lander and solar panel relocated to selected 3D terrain point");
    }
  };

  function buildTimelineBands(traj) {
    if (!traj.length) return;
    tlSunBands.innerHTML = "";
    tlDteBands.innerHTML = "";
    traj.forEach((p) => {
      const s = document.createElement("i");
      s.style.flex = "1";
      s.style.background = p.power_tracking_w > 5 ? "var(--sun)" : "#cbd5e1";
      tlSunBands.appendChild(s);

      const d = document.createElement("i");
      d.style.flex = "1";
      d.style.background = p.dte_visible ? "var(--accent)" : "transparent";
      tlDteBands.appendChild(d);
    });
  }

  function renderTimelineFrame(frame) {
    tlScrub.value = frame.currentTimeSec.toFixed(2);
    tlScrub.style.setProperty("--val", `${(frame.progress * 100).toFixed(1)}%`);

    tlTitle.textContent = `Day ${frame.day.toFixed(1)} of 7 · ${frame.currentTimeSec.toFixed(1)} s / 20 s`;
    tlSub.textContent = frame.sunVisible
      ? `Sun visible at ${frame.sunElev.toFixed(2)}° · Azimuth ${Math.round(frame.sunAz)}°`
      : `Shadow behind ridge · Sun at ${frame.sunElev.toFixed(2)}°`;

    kpiWh.textContent = frame.cumTrackingWh.toLocaleString("en-US");
    kpiSoc.textContent = Math.round(frame.batterySoc);
    kpiHeater.textContent = frame.heatersActive ? "Survival heater 25 W active" : "Charging with panel";
    kpiHeater.className = frame.heatersActive ? "" : "pos";
    kpiDte.textContent = frame.dteVisible ? "Direct contact" : "Behind ridge";
    kpiDte.style.color = frame.dteVisible ? "var(--ok)" : "var(--text-1)";

    twin.updateSunPosition(frame.sunAz, frame.sunElev, frame.sunVisible, frame.progress);

    if (armMode === "AUTO") {
      const trackAngles = twin.computeSunTrackingAngles(frame.sunAz, frame.sunElev, frame.progress, frame.sunVisible);
      setSlidersUI(trackAngles);
      twin.updateArmJoints(trackAngles, true);
      telemetry.sendArmCommand(trackAngles.map((v) => Math.round(v)), "AUTO_SUN_TRACK");
    }

    if (appMode === "DEMO") {
      const simV = frame.sunVisible ? (2.65 + 0.45 * Math.sin(frame.progress * Math.PI)) : 0.08;
      valSolar.textContent = simV.toFixed(2);
      barSolar.style.width = `${Math.round((simV / 3.3) * 100)}%`;
      solarBadge.textContent = frame.sunVisible ? "Receiving sunlight" : "In polar shadow";
      solarBadge.className = `sensor-state ${frame.sunVisible ? "ok" : "warn"}`;
    }
  }

  function renderLinkStatus(link) {
    if (link.esp32_state === "ONLINE") {
      espDot.className = "live-dot ok";
      modeLiveDot.className = "live-dot ok";
      espText.textContent = "Arm connected";
      const subParts = [];
      if (link.path) subParts.push(link.path);
      if (link.cmd_latency_ms) subParts.push(`${Math.round(link.cmd_latency_ms)} ms`);
      espSub.textContent = subParts.length ? `· ${subParts.join(" · ")}` : "";
    } else if (link.esp32_state === "NO_DATA") {
      espDot.className = "live-dot warn";
      modeLiveDot.className = "live-dot warn";
      espText.textContent = "ESP32 standby";
      espSub.textContent = link.last_packet_age_s ? `· ${Math.round(link.last_packet_age_s)} s ago` : "";
    } else {
      espDot.className = "live-dot";
      modeLiveDot.className = "live-dot";
      espText.textContent = "Arm disconnected";
      espSub.textContent = link.cloud_connected ? "· Cloud ready" : "";
    }
  }

  function renderLiveSensors(data) {
    if (data.solar_voltage_v !== null && data.solar_voltage_v !== undefined) {
      const v = Number(data.solar_voltage_v);
      valSolar.textContent = v.toFixed(2);
      barSolar.style.width = `${Math.min(100, Math.max(0, Math.round((v / 3.3) * 100)))}%`;
      const lit = v >= 0.6;
      solarBadge.textContent = lit ? "Generating real power" : "Low panel light";
      solarBadge.className = `sensor-state ${lit ? "ok" : "warn"}`;
    } else {
      valSolar.textContent = "--";
      barSolar.style.width = "0%";
      solarBadge.textContent = "Waiting for ADC reading";
      solarBadge.className = "sensor-state";
    }

    if (data.dht22_temp_c !== null && data.dht22_temp_c !== undefined) {
      const t = Number(data.dht22_temp_c);
      valTemp.textContent = t.toFixed(1);
      barTemp.style.width = `${Math.min(100, Math.max(0, Math.round(((t + 5) / 55) * 100)))}%`;
    } else {
      valTemp.textContent = "--";
      barTemp.style.width = "0%";
    }

    if (data.dht22_humidity_pct !== null && data.dht22_humidity_pct !== undefined) {
      const h = Number(data.dht22_humidity_pct);
      valHum.textContent = h.toFixed(1);
      barHum.style.width = `${Math.min(100, Math.max(0, Math.round(h)))}%`;
    } else {
      valHum.textContent = "--";
      barHum.style.width = "0%";
    }
  }

  // ============================================================================
  // VIEW TRANSITIONS & LAYER CONTROLS
  // ============================================================================

  function enterSurfaceView(after) {
    twin.flyToSurface(() => {
      globeHero.classList.add("hide");
      layerbar.classList.remove("hide");
      updateLayerLegend(twin.currentLayer);
      viewToggleLabel.textContent = "Full Moon globe";
      if (appMode === "DEMO" && armMode === "AUTO" && !sim.isPlaying) {
        sim.play();
      }
      if (after) after();
    });
  }

  function enterGlobeView(after) {
    twin.flyToGlobe(() => {
      layerbar.classList.add("hide");
      layerLegend.classList.add("hide");
      globeHero.classList.remove("hide");
      viewToggleLabel.textContent = "Descend to surface";
      if (after) after();
    });
  }

  function ensureArmVisibleIn3D() {
    if (twin.viewMode === "globe") {
      enterSurfaceView(() => twin.focusOnArm());
    } else {
      twin.focusOnArm();
    }
  }

  btnDescend.addEventListener("click", () => {
    enterSurfaceView(() => showToast("LOLA polar surface · 16 × 16 km"));
  });

  btnViewToggle.addEventListener("click", () => {
    if (twin.viewMode === "globe") {
      enterSurfaceView(() => showToast("LOLA polar surface · 16 × 16 km"));
    } else {
      enterGlobeView(() => showToast("Full Moon globe view"));
    }
  });

  btnResetCam.addEventListener("click", () => {
    twin.resetCamera();
    showToast("Camera centered");
  });

  if (btnExportReport) {
    btnExportReport.addEventListener("click", () => {
      window.open("/api/mission/report?format=markdown", "_blank");
      showToast("Downloading mission technical report (MCDA)...");
    });
  }

  espPill.addEventListener("click", () => {
    activateTab("sensors");
    const st = telemetry.linkStatus.esp32_state;
    if (st === "ONLINE") {
      showToast("ESP32 connected and streaming in real time");
    } else {
      showToast("Cloud broker connected · Waiting for ESP32 power-on (eq01)");
    }
  });

  // Layer buttons
  const LAYER_NAMES = {
    realistic: "Layer: LOLA Topographic Relief",
    slope: "Layer: Terrain Slope & Safety Map",
    sun: "Layer: Ray-Cast 7-Day Solar Illumination",
    cryo: "Layer: Cryogenic Cold Traps (< 110 K)"
  };

  layerbar.querySelectorAll("[data-layer]").forEach((btn) => {
    btn.addEventListener("click", () => {
      layerbar.querySelectorAll("[data-layer]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const layer = btn.getAttribute("data-layer");
      twin.applyLayerColors(layer);
      updateLayerLegend(layer);
      showToast(LAYER_NAMES[layer] || layer);
    });
  });

  function updateLayerLegend(layer) {
    if (layer === "realistic") {
      layerLegend.classList.add("hide");
      return;
    }
    layerLegend.classList.remove("hide");
    if (layer === "slope") {
      layerLegend.innerHTML = `
        <span><i style="background:#17a34a"></i>0°–5° Optimal</span>
        <span><i style="background:#4ade80"></i>5°–15° Safe</span>
        <span><i style="background:#f59e0b"></i>15°–20° Caution</span>
        <span><i style="background:#dc2626"></i>&gt;20° Hazard</span>
      `;
    } else if (layer === "sun") {
      layerLegend.innerHTML = `
        <span>0% Shadow</span>
        <span class="ramp" style="background:linear-gradient(90deg,#1f2947,#d97706,#facc15)"></span>
        <span>100% Continuous Sun (7 days)</span>
      `;
    } else if (layer === "cryo") {
      layerLegend.innerHTML = `
        <span><i style="background:#2ec4fa"></i>Permanent shadow (&lt;110 K · Stable ice)</span>
        <span><i style="background:#94a3b8"></i>Illuminated terrain</span>
      `;
    }
  }

  btnToggleZones.addEventListener("click", () => {
    const next = !twin.showZones;
    twin.setZonesVisibility(next);
    btnToggleZones.setAttribute("aria-pressed", String(next));
    btnToggleZones.style.opacity = next ? "1" : "0.55";
    showToast(next ? "Safe zones visible" : "Safe zones hidden");
  });

  // ============================================================================
  // MODE, TABS & ARM SLIDERS
  // ============================================================================

  btnModeLive.addEventListener("click", () => {
    appMode = "LIVE";
    btnModeLive.classList.add("active");
    btnModeLive.setAttribute("aria-selected", "true");
    btnModeDemo.classList.remove("active");
    btnModeDemo.setAttribute("aria-selected", "false");
    sim.pause();
    rightSubtitle.textContent = "Direct ESP32 hardware streaming";
    sensorNotice.innerHTML = "<strong>Live mode</strong> active. Illuminating the physical solar panel outdoors or with a lamp increases voltage in real time.";
    renderLiveSensors(telemetry.latestTelemetry);
    activateTab("sensors");
    showToast("Live mode · Streaming real ESP32 sensors");
  });

  btnModeDemo.addEventListener("click", () => {
    const wasDemo = appMode === "DEMO";
    appMode = "DEMO";
    btnModeDemo.classList.add("active");
    btnModeDemo.setAttribute("aria-selected", "true");
    btnModeLive.classList.remove("active");
    btnModeLive.setAttribute("aria-selected", "false");
    rightSubtitle.textContent = "7-day orbital simulation in 20 s";
    sensorNotice.innerHTML = "Displaying <strong>demo mode</strong> data. Switch to <strong>Live</strong> above to read the physical ESP32 solar panel and DHT22.";
    setArmMode("AUTO", true);
    if (wasDemo) {
      sim.togglePlay();
    } else {
      sim.play();
    }
    showToast(sim.isPlaying ? "Simulating 7 lunar days in 20 seconds" : "Simulation paused");
  });

  // Panel collapse buttons
  collapseLeft.addEventListener("click", () => panelLeft.classList.toggle("collapsed"));
  collapseRight.addEventListener("click", () => panelRight.classList.toggle("collapsed"));

  // Right panel tabs
  panelRight.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activateTab(btn.getAttribute("data-tab"));
    });
  });

  // Arm manual vs auto solar
  function setArmMode(mode, focus3D = true) {
    armMode = mode;
    btnArmManual.classList.toggle("active", mode === "MANUAL");
    btnArmAuto.classList.toggle("active", mode === "AUTO");
    if (mode === "AUTO") {
      highlightPreset("sun");
      if (lastFrame) {
        const a = twin.computeSunTrackingAngles(lastFrame.sunAz, lastFrame.sunElev, lastFrame.progress, lastFrame.sunVisible);
        setSlidersUI(a);
        twin.updateArmJoints(a, true);
        telemetry.sendArmCommand(a.map((v) => Math.round(v)), "AUTO_SUN_TRACK");
      }
    }
    if (focus3D) ensureArmVisibleIn3D();
  }

  btnArmManual.addEventListener("click", () => {
    setArmMode("MANUAL", true);
    highlightPreset(null);
    showToast("Manual arm control active");
  });

  btnArmAuto.addEventListener("click", () => {
    setArmMode("AUTO", true);
    showToast("Automatic sun tracking active");
  });

  function setSlidersUI(angles) {
    angles.forEach((val, i) => {
      const [minA, maxA] = JOINT_LIMITS[i] || [0, 180];
      const v = Math.max(minA, Math.min(maxA, Math.round(val)));
      sliders[i].value = v;
      const pct = ((v - minA) / Math.max(1, maxA - minA)) * 100;
      sliders[i].style.setProperty("--val", `${pct.toFixed(1)}%`);
      sliderLabels[i].textContent = `${v}°`;
    });
  }

  sliders.forEach((s) => {
    s.addEventListener("input", () => {
      if (armMode !== "MANUAL") setArmMode("MANUAL", false);
      highlightPreset(null);
      lastLocalCommandMs = performance.now();
      const rawAngles = sliders.map((el) => parseInt(el.value, 10));
      const safeAngles = twin.clampArmAngles(rawAngles);
      setSlidersUI(safeAngles);
      twin.updateArmJoints(safeAngles);
      ensureArmVisibleIn3D();
      telemetry.sendArmCommand(safeAngles, "MANUAL");
    });
  });

  // 180-Deg Physical Servo Calibration & Auto-Home Controls
  const btnAutoCal = $("btn-autocal");
  const btnToggleCal = $("btn-toggle-cal");
  const btnResetCal = $("btn-reset-cal");
  const calDrawer = $("cal-drawer");
  const calRowsEl = $("cal-rows");
  const jointNamesShort = ["1. Base", "2. Shoulder", "3. Elbow", "4. Wrist", "5. Roll"];
  let servoTrim = [0, 0, 0, 0, 0];
  let servoDir = [1, 1, 1, 1, 1];
  try {
    const savedCal = JSON.parse(localStorage.getItem("esp32_servo_cal") || "null");
    if (savedCal && Array.isArray(savedCal.trim) && Array.isArray(savedCal.dir)) {
      servoTrim = savedCal.trim.map((n) => Math.max(-45, Math.min(45, Number(n) || 0)));
      servoDir = savedCal.dir.map((n) => (Number(n) < 0 ? -1 : 1));
    }
  } catch (_) {}

  function pushCalibrationToESP32() {
    try {
      localStorage.setItem("esp32_servo_cal", JSON.stringify({ trim: servoTrim, dir: servoDir }));
    } catch (_) {}
    const calModeStr = `CAL:${servoTrim.join(",")}:${servoDir.join(",")}`;
    const curAngles = sliders.map((el) => parseInt(el.value, 10));
    lastLocalCommandMs = performance.now();
    telemetry.sendArmCommand(curAngles, calModeStr);
  }

  function renderCalibrationRows() {
    if (!calRowsEl) return;
    calRowsEl.innerHTML = "";
    jointNamesShort.forEach((name, idx) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:4px; padding:2px 0;";
      const dirLabel = servoDir[idx] > 0 ? "Norm (+)" : "Inv (-)";
      const sign = servoTrim[idx] > 0 ? "+" : "";
      row.innerHTML = `
        <span style="min-width:66px; color:var(--text-1);">${name}</span>
        <div style="display:flex; align-items:center; gap:3px;">
          <button type="button" class="btn small" data-trim-idx="${idx}" data-trim-step="-2" style="padding:1px 6px;">-2°</button>
          <b style="min-width:34px; text-align:center; font-variant-numeric:tabular-nums;">${sign}${servoTrim[idx]}°</b>
          <button type="button" class="btn small" data-trim-idx="${idx}" data-trim-step="2" style="padding:1px 6px;">+2°</button>
          <button type="button" class="btn small ${servoDir[idx] < 0 ? "primary" : ""}" data-dir-idx="${idx}" style="padding:1px 6px; min-width:54px;">${dirLabel}</button>
        </div>
      `;
      calRowsEl.appendChild(row);
    });

    calRowsEl.querySelectorAll("[data-trim-idx]").forEach((b) => {
      b.addEventListener("click", () => {
        const i = Number(b.getAttribute("data-trim-idx"));
        const step = Number(b.getAttribute("data-trim-step"));
        servoTrim[i] = Math.max(-45, Math.min(45, servoTrim[i] + step));
        renderCalibrationRows();
        pushCalibrationToESP32();
        showToast(`${jointNamesShort[i]} trim: ${servoTrim[i] > 0 ? "+" : ""}${servoTrim[i]}° (saved to ESP32)`);
      });
    });

    calRowsEl.querySelectorAll("[data-dir-idx]").forEach((b) => {
      b.addEventListener("click", () => {
        const i = Number(b.getAttribute("data-dir-idx"));
        servoDir[i] = -servoDir[i];
        renderCalibrationRows();
        pushCalibrationToESP32();
        showToast(`${jointNamesShort[i]} direction: ${servoDir[i] > 0 ? "Normal (+)" : "Inverted (-)"}`);
      });
    });
  }
  renderCalibrationRows();

  if (btnToggleCal && calDrawer) {
    btnToggleCal.addEventListener("click", () => {
      calDrawer.classList.toggle("hide");
    });
  }

  if (btnResetCal) {
    btnResetCal.addEventListener("click", () => {
      servoTrim = [0, 0, 0, 0, 0];
      servoDir = [1, 1, 1, 1, 1];
      renderCalibrationRows();
      pushCalibrationToESP32();
      showToast("All 180° servo trims reset to 0° and Normal direction");
    });
  }

  if (btnAutoCal) {
    btnAutoCal.addEventListener("click", () => {
      setArmMode("MANUAL", true);
      highlightPreset("home");
      lastLocalCommandMs = performance.now();
      const homeAngles = PRESETS.home.angles;
      setSlidersUI(homeAngles);
      twin.updateArmJoints(homeAngles);
      telemetry.sendArmCommand(homeAngles, "CALIBRATE");
      showToast("ESP32-S3 executing 180° sequential auto-calibration & homing...");
    });
  }

  // Preset buttons
  presetButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-preset");
      highlightPreset(key);
      lastLocalCommandMs = performance.now();
      if (key === "sun") {
        setArmMode("AUTO", true);
        showToast("Solar panel oriented perpendicular to the Sun");
        return;
      }
      if (key === "dust") {
        setArmMode("MANUAL", true);
        ensureArmVisibleIn3D();
        const preset = PRESETS.dust;
        setSlidersUI(preset.angles);
        showToast("Electrostatic dust shedding active · Vibrating panel to shed regolith...");
        telemetry.sendArmCommand(preset.angles, "DUST_SHED");
        twin.triggerDustSheddingRoutine(() => {
          showToast("Panel cleared (100% optical transmission restored) · Resuming solar tracking");
          setArmMode("AUTO", true);
        });
        return;
      }
      setArmMode("MANUAL", true);
      highlightPreset(key);
      const preset = PRESETS[key] || PRESETS.home;
      const safePresetAngles = twin.clampArmAngles(preset.angles);
      setSlidersUI(safePresetAngles);
      twin.updateArmJoints(safePresetAngles);
      telemetry.sendArmCommand(safePresetAngles, key === "home" ? "CALIBRATE" : "PRESET");
      showToast(preset.label);
    });
  });

  // Timeline controls
  btnPlay.addEventListener("click", () => {
    if (appMode !== "DEMO") {
      btnModeDemo.click();
      return;
    }
    if (!sim.isPlaying) {
      setArmMode("AUTO", true);
    }
    sim.togglePlay();
  });

  tlScrub.addEventListener("input", (ev) => {
    sim.pause();
    if (armMode !== "AUTO") setArmMode("AUTO", false);
    sim.seek(parseFloat(ev.target.value));
  });

  // ============================================================================
  // GUIDED MISSION TOUR FOR NASA JUDGES (POINT 1)
  // ============================================================================
  let currentTourStep = 0;
  let isTourActive = false;
  let tourHighlightedEl = null;

  const TOUR_STEPS = [
    {
      step: 1,
      total: 5,
      tag: "Step 1 of 5 · Global Artemis Analysis",
      title: "Artemis Site Selection & LOLA Topography",
      desc: "Using NASA Lunar Reconnaissance Orbiter (LRO) LOLA laser altimeter data, our Multi-Criteria Decision Analysis (MCDA) scored 4 candidate regions at the Lunar South Pole (85°S–90°S). <strong>Connecting Ridge</strong> ranks #1 with an 85.8 composite score due to 86% continuous solar illumination and direct Earth line-of-sight.",
      callout: "Winner: Connecting Ridge · Score 85.8/100 · +1,415 m Elevation · 86% Sun",
      targetId: "panel-left",
      positionTop: false,
      action: () => {
        panelLeft.classList.remove("collapsed");
        panelRight.classList.add("collapsed");
        selectSite(0, false);
        if (twin.viewMode !== "globe") {
          enterGlobeView();
        }
      }
    },
    {
      step: 2,
      total: 5,
      tag: "Step 2 of 5 · Precision Touchdown & Water-Ice Access",
      title: "5 Tactical Safe Zones & Ice Extraction Proximity",
      desc: "NASA Artemis human landing criteria require slopes &lt; 5° and roughness &lt; 0.15 m to prevent lander tip-over, combined with proximity to water ice for In-Situ Resource Utilization (ISRU). Our algorithm identified 5 certified footprints on Connecting Ridge. Safe Zone #1 is the primary site (2.1° slope), situated only 260 m from a micro-cold trap and 5.6 km from Shackleton Crater's main ice reservoir.",
      callout: "Safe Zone #1: 2.1° Slope · 100 m Radius · 260 m to Local Cold Trap / 5.6 km to Shackleton",
      targetId: "panel-left",
      positionTop: false,
      action: () => {
        panelLeft.classList.remove("collapsed");
        panelRight.classList.add("collapsed");
        enterSurfaceView(() => {
          twin.applyLayerColors("slope");
          updateLayerLegend("slope");
          layerbar.querySelectorAll("[data-layer]").forEach((b) => {
            b.classList.toggle("active", b.getAttribute("data-layer") === "slope");
          });
          if (zones && zones.length > 0) {
            setActiveZoneUI(1);
            twin.focusOnZone(zones[0]);
          }
        });
      }
    },
    {
      step: 3,
      total: 5,
      tag: "Step 3 of 5 · Solar Robotics Engine",
      title: "Continuous Sun-Tracking Arm (+50.1x Energy)",
      desc: "Because the polar Sun grazes the horizon at only 1.5°–3.0°, a conventional fixed horizontal panel yields almost zero power (315 Wh over 7 days). Our 5-DOF robotic arm tracks the low polar sun normal to the solar vector, generating <strong>15,795 Wh (+50.1x gain)</strong> and keeping the 5 kWh battery buffer charged through cryogenic shadows.",
      callout: "Harvested: 15,795 Wh vs 315 Wh Fixed (+50.1x Gain) · 5 kWh Battery Buffer Sustained",
      targetSelector: ".missionbar",
      positionTop: true,
      action: () => {
        panelLeft.classList.add("collapsed");
        panelRight.classList.add("collapsed");
        twin.applyLayerColors("realistic");
        updateLayerLegend("realistic");
        layerbar.querySelectorAll("[data-layer]").forEach((b) => {
          b.classList.toggle("active", b.getAttribute("data-layer") === "realistic");
        });
        setArmMode("AUTO", true);
        if (appMode !== "DEMO") {
          btnModeDemo.click();
        }
        sim.seek(2.0);
        sim.play();
      }
    },
    {
      step: 4,
      total: 5,
      tag: "Step 4 of 5 · IoT Hardware Integration",
      title: "Hardware-In-The-Loop ESP32 Teleoperation",
      desc: "The 5-DOF robotic arm is backed by a physical ESP32 microcontroller streaming bidirectional telemetry over secure SSL WebSockets to Google Cloud. Real-time sensors measure panel voltage, ambient temperature, humidity, and servo angle feedback with automated fail-safe stow hibernation.",
      callout: "Link: WebSocket SSL (wss://) · Device: ESP32-S3 (eq01) · 5-DOF Robotic Arm",
      targetId: "panel-right",
      positionTop: false,
      action: () => {
        panelLeft.classList.add("collapsed");
        panelRight.classList.remove("collapsed");
        activateTab("control");
        highlightPreset("sun");
      }
    },
    {
      step: 5,
      total: 5,
      tag: "Step 5 of 5 · NASA Evaluation Export",
      title: "One-Click Technical Mission Report",
      desc: "Evaluators and mission planners can export the complete decision-support package instantly. Clicking <strong>Report</strong> generates a comprehensive NASA-standard Markdown and JSON document containing the complete MCDA evaluation matrix, topographical coordinates, and the 7-day energy profile.",
      callout: "Export Ready: Full MCDA Matrix · Top 5 Safe Zones · 7-Day Power & Telecom Profile",
      targetId: "btn-export-report",
      positionTop: false,
      action: () => {
        panelLeft.classList.remove("collapsed");
        panelRight.classList.remove("collapsed");
        sim.pause();
      }
    }
  ];

  function clearTourHighlight() {
    if (tourHighlightedEl) {
      tourHighlightedEl.classList.remove("tour-highlight");
      if (tourHighlightedEl.dataset.addedPosRelative === "true") {
        tourHighlightedEl.style.position = "";
        delete tourHighlightedEl.dataset.addedPosRelative;
      }
      tourHighlightedEl = null;
    }
  }

  function renderTourStep(index) {
    if (index < 0 || index >= TOUR_STEPS.length) return;
    currentTourStep = index;
    const step = TOUR_STEPS[index];

    clearTourHighlight();

    let target = null;
    if (step.targetId) {
      target = $(step.targetId);
    } else if (step.targetSelector) {
      target = document.querySelector(step.targetSelector);
    }

    if (target) {
      tourHighlightedEl = target;
      tourHighlightedEl.classList.add("tour-highlight");
      const computedPos = window.getComputedStyle(target).position;
      if (computedPos === "static") {
        target.style.position = "relative";
        target.dataset.addedPosRelative = "true";
      }
      if (typeof target.scrollIntoView === "function" && target.id !== "panel-left" && target.id !== "panel-right") {
        target.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }

    tourStepTag.textContent = step.tag;
    tourStepTitle.textContent = step.title;
    tourStepDesc.innerHTML = step.desc;
    tourCallout.innerHTML = step.callout;
    tourProgressBar.style.width = `${((index + 1) / step.total) * 100}%`;

    if (step.positionTop) {
      tourCard.classList.add("position-top");
    } else {
      tourCard.classList.remove("position-top");
    }

    tourBtnPrev.disabled = index === 0;
    if (index === step.total - 1) {
      tourBtnNext.textContent = "Finish & Explore";
    } else {
      tourBtnNext.textContent = "Next →";
    }

    if (typeof step.action === "function") {
      step.action();
    }
  }

  function startTour() {
    isTourActive = true;
    tourBackdrop.classList.remove("hide");
    tourCard.classList.remove("hide");
    renderTourStep(0);
    showToast("Starting Mission Tour (30 s walkthrough)");
  }

  function stopTour(completed = false) {
    isTourActive = false;
    clearTourHighlight();
    tourBackdrop.classList.add("hide");
    tourCard.classList.add("hide");
    tourCard.classList.remove("position-top");
    panelLeft.classList.remove("collapsed");
    panelRight.classList.remove("collapsed");
    if (completed) {
      showToast("Mission Tour complete · Enjoy exploring the Digital Twin!");
    } else {
      showToast("Mission Tour closed");
    }
  }

  if (btnStartTour) {
    btnStartTour.addEventListener("click", () => startTour());
  }
  if (tourBtnClose) tourBtnClose.addEventListener("click", () => stopTour(false));
  if (tourBtnSkip) tourBtnSkip.addEventListener("click", () => stopTour(false));
  if (tourBackdrop) tourBackdrop.addEventListener("click", () => stopTour(false));
  if (tourBtnPrev) {
    tourBtnPrev.addEventListener("click", () => {
      if (currentTourStep > 0) renderTourStep(currentTourStep - 1);
    });
  }
  if (tourBtnNext) {
    tourBtnNext.addEventListener("click", () => {
      if (currentTourStep < TOUR_STEPS.length - 1) {
        renderTourStep(currentTourStep + 1);
      } else {
        stopTour(true);
      }
    });
  }

  // Keyboard shortcuts
  window.addEventListener("keydown", (ev) => {
    if (isTourActive) {
      if (ev.key === "Escape") {
        stopTour(false);
        return;
      } else if (ev.key === "ArrowRight") {
        tourBtnNext.click();
        return;
      } else if (ev.key === "ArrowLeft") {
        tourBtnPrev.click();
        return;
      }
    }
    if (ev.target.tagName === "INPUT") return;
    if (ev.code === "Space") {
      ev.preventDefault();
      btnPlay.click();
    } else if (ev.key === "r" || ev.key === "R") {
      btnResetCam.click();
    } else if (ev.key === "g" || ev.key === "G") {
      btnViewToggle.click();
    }
  });
});
