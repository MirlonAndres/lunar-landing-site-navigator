/**
 * Three.js WebGL "Globe-to-Site" 3D Lunar Digital Twin Engine
 * Motor 3D WebGL "Del Globo al Sitio" con Luna Completa NASA y Terreno LOLA
 * NASA Space Apps Challenge 2026 - Lunar Landing Site Navigator
 */

class LunarDigitalTwin {
  constructor(containerId, labelsId) {
    this.container = document.getElementById(containerId);
    this.labelsContainer = document.getElementById(labelsId);
    this.fadeEl = document.getElementById("fade");

    this.viewMode = "globe"; // "globe" | "surface"
    this._transitionTimer = null;

    // Terrain & illumination datasets
    this.meshData = null;
    this.illumData = null;
    this.currentLayer = "realistic";
    this.showZones = true;

    // Sun & Earth state
    this.sunAzimuthDeg = 175.0;
    this.sunElevationDeg = 1.05;

    // Globe markers & rotation
    this.globePins = [];
    this.selectedSiteIdx = 0;
    this._globeBaseYaw = 0.0;
    this._globeTargetYaw = 0.0;
    this.onSelectSiteFromGlobe = null;

    // 4 Artemis candidate site surface sectors (pixel coords 0..3200 on LOLA DEM)
    this.siteSurfaceCoords = [
      { px: 2513, py: 2251, label: "Connecting Ridge" },   // Site 01: Prime Ridge (with Lander)
      { px: 1920, py: 1120, label: "North Peak" },         // Site 02: High illuminated peak
      { px: 820,  py: 980,  label: "Malapert Mountain" },  // Site 03: High massif sector
      { px: 1380, py: 2620, label: "Faustini Rim A" }      // Site 04: Deep cryogenic crater rim
    ];

    // Anatomical / mechanical joint limits matching physical 3D-printed arm & solar panel [min, max]
    this.jointLimits = [
      [25, 155], // Joint 0: Base Turntable Yaw
      [35, 110], // Joint 1: Shoulder Pitch
      [40, 120], // Joint 2: Elbow Flexion
      [45, 130], // Joint 3: Wrist Pitch (panel clearance)
      [35, 145]  // Joint 4: Panel Roll (panel corner clearance)
    ];

    // Smooth 5-DOF Robotic Arm interpolation state (calibrated home posture)
    this._currentArmAngles = [90, 55, 60, 70, 90];
    this._targetArmAngles = [90, 55, 60, 70, 90];

    // Relocation & camera tween state
    this._camTween = null;
    this._landerTween = null;
    this._landerTargetPos = null;
    this.zoneLabelEls = [];
    this.activeZoneRank = 1;

    this._initScene();
  }

  _initScene() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070b);

    this.camera = new THREE.PerspectiveCamera(38, w / h, 0.5, 4000);
    this.camera.position.set(0, 0, 285);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 120;
    this.controls.maxDistance = 420;
    this.controls.target.set(0, 0, 0);

    this.globeGroup = new THREE.Group();
    // Tilt lunar South Pole toward viewer so all 4 polar sites sit clearly on the front face
    this.globeGroup.rotation.x = -0.78;
    this.surfaceGroup = new THREE.Group();
    this.surfaceGroup.visible = false;
    this.scene.add(this.globeGroup);
    this.scene.add(this.surfaceGroup);

    this._buildStars();
    this._setupLights();
    this._buildMoonGlobe();
    this._buildEarth();
    this._buildLanderAndArm();
    this._buildIceCorridor();
    this._setupSurfaceClickPlacement();

    window.addEventListener("resize", () => this._onResize());
    this._animate();
  }

  /**
   * Allows clicking any 3D zone pin or any point on the lunar terrain to relocate the Lander & Arm.
   * Permite hacer clic en cualquier pin de zona o punto del terreno 3D para reubicar el modulo y brazo.
   */
  _setupSurfaceClickPlacement() {
    this._raycaster = new THREE.Raycaster();
    this._pointerDownPos = null;

    this.renderer.domElement.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      this._pointerDownPos = { x: ev.clientX, y: ev.clientY, t: performance.now() };
    });

    this.renderer.domElement.addEventListener("pointerup", (ev) => {
      if (!this._pointerDownPos || this.viewMode !== "surface") return;
      const dist = Math.hypot(ev.clientX - this._pointerDownPos.x, ev.clientY - this._pointerDownPos.y);
      const dt = performance.now() - this._pointerDownPos.t;
      this._pointerDownPos = null;
      if (dist > 6 || dt > 500) return;

      const rect = this.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1
      );
      this._raycaster.setFromCamera(ndc, this.camera);

      if (this.zoneMarkers && this.zoneMarkers.length) {
        const markerHits = this._raycaster.intersectObjects(this.zoneMarkers, true);
        if (markerHits.length > 0) {
          let obj = markerHits[0].object;
          while (obj && (!obj.userData || !obj.userData.zone)) {
            obj = obj.parent;
          }
          if (obj && obj.userData && obj.userData.zone) {
            this.focusOnZone(obj.userData.zone);
            if (this.onSurfacePointSelect) {
              this.onSurfacePointSelect({ type: "zone", zone: obj.userData.zone });
            }
            return;
          }
        }
      }

      if (this.terrainMesh) {
        const terrainHits = this._raycaster.intersectObject(this.terrainMesh, false);
        if (terrainHits.length > 0) {
          const pt = terrainHits[0].point;
          if (this.zoneMarkers && this.zoneMarkers.length) {
            for (const m of this.zoneMarkers) {
              if (m.userData && m.userData.worldPos && m.userData.worldPos.distanceTo(pt) < 7.5) {
                this.focusOnZone(m.userData.zone);
                if (this.onSurfacePointSelect) {
                  this.onSurfacePointSelect({ type: "zone", zone: m.userData.zone });
                }
                return;
              }
            }
          }
          this.relocateLanderTo(pt, null);
          this.focusOnArm(true);
          if (this.onSurfacePointSelect) {
            this.onSurfacePointSelect({ type: "terrain", point: pt });
          }
        }
      }
    });
  }

  _buildStars() {
    const count = 2400;
    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2 * Math.PI;
      const phi = Math.acos(2 * v - 1);
      const r = 1400 + Math.random() * 400;

      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi);
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

      const b = 0.7 + Math.random() * 0.3;
      col[i * 3] = b;
      col[i * 3 + 1] = b;
      col[i * 3 + 2] = Math.min(1, b * 1.05);
    }
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(col, 3));

    const mat = new THREE.PointsMaterial({ size: 1.6, vertexColors: true, transparent: true, opacity: 0.85 });
    this.scene.add(new THREE.Points(geom, mat));
  }

  _setupLights() {
    this.ambientLight = new THREE.AmbientLight(0x283244, 0.55);
    this.scene.add(this.ambientLight);

    this.hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x0f172a, 0.28);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfff7e6, 1.75);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 1400;
    this.sunLight.shadow.bias = -0.0003;
    const d = 145;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.scene.add(this.sunLight);

    const sunGeom = new THREE.SphereGeometry(12, 24, 24);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xfde047 });
    this.sunSphere = new THREE.Mesh(sunGeom, sunMat);
    const sunHaloGeom = new THREE.SphereGeometry(20, 24, 24);
    const sunHaloMat = new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.38,
      depthWrite: false
    });
    this.sunSphere.add(new THREE.Mesh(sunHaloGeom, sunHaloMat));
    this.scene.add(this.sunSphere);

    this.updateSunPosition(this.sunAzimuthDeg, this.sunElevationDeg);
  }

  _buildMoonGlobe() {
    const loader = new THREE.TextureLoader();
    const colorTex = loader.load("assets/moon/moon_color_4k.jpg");
    const bumpTex = loader.load("assets/moon/moon_displacement.png");
    colorTex.anisotropy = 8;

    this.moonRadius = 74;
    const geom = new THREE.SphereGeometry(this.moonRadius, 96, 64);
    const mat = new THREE.MeshStandardMaterial({
      map: colorTex,
      bumpMap: bumpTex,
      bumpScale: 1.35,
      roughness: 0.92,
      metalness: 0.02
    });

    this.moonSphere = new THREE.Mesh(geom, mat);
    this.moonSphere.receiveShadow = true;
    this.globeGroup.add(this.moonSphere);

    // Subtle limb atmosphere rim for contrast against deep space
    const rimGeom = new THREE.SphereGeometry(this.moonRadius * 1.012, 64, 48);
    const rimMat = new THREE.MeshBasicMaterial({
      color: 0x93c5fd,
      transparent: true,
      opacity: 0.06,
      side: THREE.BackSide
    });
    this.globeGroup.add(new THREE.Mesh(rimGeom, rimMat));
  }

  _buildEarth() {
    const loader = new THREE.TextureLoader();
    const earthTex = loader.load("assets/earth/earth_day_2k.jpg");
    const geom = new THREE.SphereGeometry(16, 48, 32);
    const mat = new THREE.MeshPhongMaterial({
      map: earthTex,
      specular: 0x334155,
      shininess: 14
    });
    this.earthMesh = new THREE.Mesh(geom, mat);
    this.earthMesh.position.set(115, 78, -360);
    this.scene.add(this.earthMesh);

    const haloGeom = new THREE.SphereGeometry(17.4, 32, 32);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x60a5fa,
      transparent: true,
      opacity: 0.2,
      side: THREE.BackSide
    });
    this.earthMesh.add(new THREE.Mesh(haloGeom, haloMat));
  }

  /**
   * Places the 4 Artemis polar candidate sites on the 3D Moon globe with HTML chips.
   * Coloca los 4 sitios candidatos polares Artemis sobre el globo lunar 3D con etiquetas HTML.
   */
  setGlobeSites(sites, onSelect) {
    this.onSelectSiteFromGlobe = onSelect;
    this.globePins.forEach((p) => {
      this.moonSphere.remove(p.mesh);
      if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
    });
    this.globePins = [];

    // Polar markers placed on the front-facing south polar cap so all 4 chips stay clearly visible
    const visualCoords = [
      { lat: -62.0, lon: 268.0, yaw: 0.0 },   // Site 01: Connecting Ridge
      { lat: -54.0, lon: 295.0, yaw: -0.22 }, // Site 02: North Peak
      { lat: -46.0, lon: 245.0, yaw: 0.18 },  // Site 03: Malapert Mountain
      { lat: -58.0, lon: 235.0, yaw: 0.25 }   // Site 04: Faustini Rim A
    ];

    sites.forEach((site, idx) => {
      const c = visualCoords[idx] || { lat: site.latitude_deg, lon: site.longitude_deg, yaw: 0 };
      const phi = (90 - c.lat) * (Math.PI / 180);
      const theta = (c.lon + 180) * (Math.PI / 180);
      const r = this.moonRadius + 0.9;

      const pos = new THREE.Vector3(
        -r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta)
      );

      const pinGeom = new THREE.SphereGeometry(1.5, 16, 16);
      const pinMat = new THREE.MeshBasicMaterial({ color: idx === 0 ? 0x38bdf8 : 0xffffff });
      const pinMesh = new THREE.Mesh(pinGeom, pinMat);
      pinMesh.position.copy(pos);
      this.moonSphere.add(pinMesh);

      const el = document.createElement("div");
      el.className = `geo-label ${idx === 0 ? "selected" : ""}`;
      const shortName = (site.name_en || site.name_es).split("(")[0].trim();
      el.innerHTML = `
        <div class="chip"><span>${shortName}</span><small>${Math.round(site.sun_illumination_pct)}% sun</small></div>
        <div class="stem"></div>
        <div class="dot"></div>
      `;
      el.querySelector(".chip").addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (this.onSelectSiteFromGlobe) this.onSelectSiteFromGlobe(idx, true);
      });
      this.labelsContainer.appendChild(el);

      this.globePins.push({ mesh: pinMesh, el, site, idx, targetYaw: c.yaw });
    });
  }

  highlightGlobeSite(idx) {
    this.selectedSiteIdx = idx;
    this.globePins.forEach((p, i) => {
      const active = i === idx;
      p.el.classList.toggle("selected", active);
      p.mesh.material.color.setHex(active ? 0x38bdf8 : 0xffffff);
      p.mesh.scale.setScalar(active ? 1.35 : 1.0);
      if (active) {
        this._globeTargetYaw = p.targetYaw || 0.0;
      }
    });
  }

  /**
   * Builds the 256x256 LOLA polar surface mesh and positions the lander at Rank #1 zone.
   * Construye la malla polar LOLA de 256x256 y ubica el modulo en la Zona #1 real.
   */
  loadTerrainMesh(meshData, illumData) {
    this.meshData = meshData;
    this.illumData = illumData || null;

    const rows = meshData.rows;
    const cols = meshData.cols;
    const heights = meshData.heights;
    const minElev = meshData.min_elev;

    this.terrainSize = 240;
    this.elevScale = 0.022;
    this.minElev = minElev;
    this.maxElev = meshData.max_elev;

    const geom = new THREE.PlaneGeometry(this.terrainSize, this.terrainSize, cols - 1, rows - 1);
    geom.rotateX(-Math.PI / 2);

    const pos = geom.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    let k = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        pos.setY(k, (heights[r][c] - minElev) * this.elevScale);
        k++;
      }
    }

    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geom.computeVertexNormals();
    this.terrainGeometry = geom;

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.9,
      metalness: 0.05
    });

    if (this.terrainMesh) this.surfaceGroup.remove(this.terrainMesh);
    this.terrainMesh = new THREE.Mesh(geom, mat);
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.castShadow = true;
    this.surfaceGroup.add(this.terrainMesh);

    this.applyLayerColors(this.currentLayer);

    if (this.landerGroup) {
      const prime = this._worldPosFromPixel(2513, 2251);
      this.landerGroup.position.set(prime.x, prime.y + 1.4, prime.z);
    }
  }

  _worldPosFromPixel(px, py) {
    const worldX = ((px - 1600) / 1600) * (this.terrainSize / 2);
    const worldZ = ((py - 1600) / 1600) * (this.terrainSize / 2);
    let worldY = 20;
    if (this.meshData) {
      const r = Math.max(0, Math.min(255, Math.round((py / 3200) * 255)));
      const c = Math.max(0, Math.min(255, Math.round((px / 3200) * 255)));
      const h = this.meshData.heights[r][c];
      worldY = (h - this.minElev) * this.elevScale;
    }
    return new THREE.Vector3(worldX, worldY, worldZ);
  }

  applyLayerColors(layer) {
    this.currentLayer = layer;
    if (!this.terrainGeometry || !this.meshData) return;

    const colors = this.terrainGeometry.attributes.color.array;
    const heights = this.meshData.heights;
    const slopes = this.meshData.slopes;
    const rows = this.meshData.rows;
    const cols = this.meshData.cols;
    const minE = this.minElev;
    const rangeE = Math.max(1, this.maxElev - this.minElev);

    const illum = this.illumData ? this.illumData.illumination : null;
    const psr = this.illumData ? this.illumData.psr : null;

    let idx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const h = heights[r][c];
        const s = slopes[r][c];
        const normH = Math.max(0, Math.min(1, (h - minE) / rangeE));
        let cr = 0.5, cg = 0.5, cb = 0.52;

        if (layer === "realistic") {
          const tone = 0.34 + normH * 0.48 - Math.min(0.12, s * 0.003);
          cr = tone * 0.97;
          cg = tone * 0.98;
          cb = tone;
        } else if (layer === "slope") {
          if (s <= 5.0) {
            cr = 0.09; cg = 0.64; cb = 0.29;
          } else if (s <= 15.0) {
            cr = 0.29; cg = 0.82; cb = 0.38;
          } else if (s <= 20.0) {
            cr = 0.92; cg = 0.58; cb = 0.07;
          } else {
            cr = 0.86; cg = 0.18; cb = 0.18;
          }
        } else if (layer === "sun") {
          const f = illum ? illum[r][c] : normH;
          cr = 0.12 + f * 0.86;
          cg = 0.16 + f * 0.68;
          cb = 0.28 + (1 - f) * 0.18;
        } else if (layer === "cryo") {
          const isPsr = psr ? psr[r][c] === 1 : normH < 0.22;
          if (isPsr) {
            cr = 0.18; cg = 0.74; cb = 0.98;
          } else {
            const tone = 0.32 + normH * 0.42;
            cr = tone * 0.92; cg = tone * 0.95; cb = tone;
          }
        }

        colors[idx * 3] = cr;
        colors[idx * 3 + 1] = cg;
        colors[idx * 3 + 2] = cb;
        idx++;
      }
    }

    this.terrainGeometry.attributes.color.needsUpdate = true;

    if (this.iceCorridorGroup) {
      this.iceCorridorGroup.visible = (layer === "cryo");
      if (layer === "cryo") {
        this.updateIceCorridor(this.activeZoneRank || 1);
      }
    }
    if (this.iceBeaconLabelEl && layer !== "cryo") {
      this.iceBeaconLabelEl.classList.add("hidden");
    }
  }

  renderLandingZones(zones) {
    if (this.zoneMarkers) {
      this.zoneMarkers.forEach((m) => this.surfaceGroup.remove(m));
    }
    if (this.zoneLabelEls) {
      this.zoneLabelEls.forEach((item) => {
        if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
      });
    }
    if (this.zonesPathLine) {
      this.surfaceGroup.remove(this.zonesPathLine);
      this.zonesPathLine = null;
    }
    this.zoneMarkers = [];
    this.zoneLabelEls = [];
    this.zonesData = zones || [];

    const pathPts = [];
    zones.forEach((z) => {
      const p = this._worldPosFromPixel(z.pixel_x, z.pixel_y);
      pathPts.push(new THREE.Vector3(p.x, p.y + 0.65, p.z));
      const group = new THREE.Group();
      group.position.set(p.x, p.y + 0.35, p.z);

      const isPrime = z.rank === 1;
      const color = isPrime ? 0x16a34a : 0x38bdf8;

      const ringGeom = new THREE.RingGeometry(4.2, 5.1, 40);
      ringGeom.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9
      });
      group.add(new THREE.Mesh(ringGeom, ringMat));

      const pinGroup = new THREE.Group();
      const stemGeom = new THREE.CylinderGeometry(0.12, 0.12, 10, 8);
      stemGeom.translate(0, 5.0, 0);
      const stemMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
      pinGroup.add(new THREE.Mesh(stemGeom, stemMat));

      const tipGeom = new THREE.SphereGeometry(0.75, 16, 16);
      tipGeom.translate(0, 10.2, 0);
      const tipMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
      pinGroup.add(new THREE.Mesh(tipGeom, tipMat));
      pinGroup.visible = !isPrime;
      group.add(pinGroup);

      group.userData = {
        zone: z,
        rank: z.rank,
        ringMat,
        pinGroup,
        worldPos: p.clone()
      };

      this.surfaceGroup.add(group);
      this.zoneMarkers.push(group);

      if (this.labelsContainer) {
        const zEl = document.createElement("div");
        zEl.className = `zone-3d-label ${isPrime ? "active" : ""} hidden`;
        const psrKm = z.proximity_to_psr_km !== undefined ? z.proximity_to_psr_km.toFixed(1) : "2.6";
        zEl.innerHTML = `<div class="zone-3d-chip">${
          isPrime
            ? `ZONE #${z.rank} · SOLAR PANEL HERE · Elev. +${Math.round(z.elevation_m)} m · Slope ${z.max_slope_deg.toFixed(1)}° · ${psrKm} km to Ice`
            : `Zone #${z.rank} · +${Math.round(z.elevation_m)} m · ${psrKm} km to Ice`
        }</div>`;
        zEl.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.focusOnZone(z);
          if (this.onSurfacePointSelect) {
            this.onSurfacePointSelect({ type: "zone", zone: z });
          }
        });
        this.labelsContainer.appendChild(zEl);
        this.zoneLabelEls.push({ zone: z, el: zEl, worldPos: p.clone() });
      }

      if (isPrime && this.landerGroup) {
        this.relocateLanderTo(p, z.rank, false);
      }
    });

    if (pathPts.length >= 2) {
      const pathGeom = new THREE.BufferGeometry().setFromPoints(pathPts);
      const pathMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.48 });
      this.zonesPathLine = new THREE.Line(pathGeom, pathMat);
      this.surfaceGroup.add(this.zonesPathLine);
    }
  }

  /**
   * Relocates the 3D Lunar Lander, 5-DOF Robotic Arm, Solar Panel, and 3D Solar Dome to any terrain point.
   * Reubica el modulo lunar 3D, el brazo robotico, el panel solar y el domo solar en cualquier punto del terreno.
   */
  relocateLanderTo(worldPos, activeZoneRank = null, animate = true) {
    if (!worldPos || !this.landerGroup) return;
    this.activeZoneRank = activeZoneRank;
    const dest = new THREE.Vector3(worldPos.x, worldPos.y + 1.4, worldPos.z);
    this._landerTargetPos = dest.clone();
    this.updateIceCorridor(activeZoneRank || 1, dest);

    if (this.zoneMarkers) {
      this.zoneMarkers.forEach((m) => {
        const isHere = m.userData && m.userData.rank === activeZoneRank;
        if (m.userData && m.userData.ringMat) {
          m.userData.ringMat.color.setHex(isHere ? 0x16a34a : 0x38bdf8);
        }
        if (m.userData && m.userData.pinGroup) {
          m.userData.pinGroup.visible = !isHere;
        }
      });
    }
    if (this.zoneLabelEls) {
      this.zoneLabelEls.forEach((item) => {
        const z = item.zone;
        const isHere = z.rank === activeZoneRank;
        item.el.classList.toggle("active", isHere);
        const chip = item.el.querySelector(".zone-3d-chip");
        if (chip) {
          chip.textContent = isHere
            ? `ZONE #${z.rank} · SOLAR PANEL HERE · Elev. +${Math.round(z.elevation_m)} m (Slope ${z.max_slope_deg.toFixed(1)}°)`
            : `Zone #${z.rank} · +${Math.round(z.elevation_m)} m`;
        }
      });
    }
    if (this.customPadRing) {
      this.customPadRing.visible = activeZoneRank === null;
    }

    if (this.relocationTrailLine) {
      this.surfaceGroup.remove(this.relocationTrailLine);
      this.relocationTrailLine = null;
    }

    const currentDist = this.landerGroup.position.distanceTo(dest);
    if (animate && this.viewMode === "surface" && currentDist > 0.5) {
      const from = this.landerGroup.position.clone();
      const arcPts = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const pt = new THREE.Vector3().lerpVectors(from, dest, t);
        pt.y += Math.sin(t * Math.PI) * 4.5;
        arcPts.push(pt);
      }
      const trailGeom = new THREE.BufferGeometry().setFromPoints(arcPts);
      const trailMat = new THREE.LineBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.85 });
      this.relocationTrailLine = new THREE.Line(trailGeom, trailMat);
      this.surfaceGroup.add(this.relocationTrailLine);

      this._landerTween = {
        from,
        to: dest.clone(),
        start: performance.now(),
        duration: 550
      };
    } else {
      this._landerTween = null;
      this.landerGroup.position.copy(dest);
      if (this.solarDomeGroup) {
        this.solarDomeGroup.position.copy(dest);
      }
    }
  }

  setZonesVisibility(visible) {
    this.showZones = visible;
    if (this.zoneMarkers) {
      this.zoneMarkers.forEach((m) => (m.visible = visible));
    }
    if (this.zonesPathLine) {
      this.zonesPathLine.visible = visible;
    }
  }

  _buildLanderAndArm() {
    this.landerGroup = new THREE.Group();
    this.landerGroup.scale.setScalar(1.65);

    const deckMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.65, roughness: 0.32 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.55, roughness: 0.42 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0x1d4ed8, metalness: 0.38, roughness: 0.35 });

    const body = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.0, 1.4, 8), deckMat);
    body.castShadow = true;
    body.receiveShadow = true;
    this.landerGroup.add(body);

    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 3.0, 8), darkMat);
      leg.position.set(Math.cos(a) * 2.5, -0.7, Math.sin(a) * 2.5);
      leg.rotation.z = -Math.cos(a) * 0.45;
      leg.rotation.x = Math.sin(a) * 0.45;
      this.landerGroup.add(leg);
    }

    // Joint 0: Base Turntable Yaw (Y axis) - Blue 3D-printed turret
    const j0 = new THREE.Group();
    j0.position.set(0, 0.75, 0);
    this.landerGroup.add(j0);
    j0.add(new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.98, 0.62, 24), accentMat));

    // Joint 1: Shoulder Pitch (Z axis) + MG996R servo housing
    const j1 = new THREE.Group();
    j1.position.set(0, 0.4, 0);
    j0.add(j1);
    const servo1 = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.48, 0.62), darkMat);
    j1.add(servo1);
    const link1Geom = new THREE.BoxGeometry(0.48, 2.0, 0.48);
    link1Geom.translate(0, 1.0, 0);
    j1.add(new THREE.Mesh(link1Geom, accentMat));

    // Joint 2: Elbow Flexion (Z axis) + MG996R servo housing
    const j2 = new THREE.Group();
    j2.position.set(0, 2.0, 0);
    j1.add(j2);
    const servo2 = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.58, 16), accentMat);
    servo2.rotation.x = Math.PI / 2;
    j2.add(servo2);
    const servo2Box = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.44, 0.6), darkMat);
    servo2Box.position.set(0, -0.15, 0.12);
    j2.add(servo2Box);
    const link2Geom = new THREE.BoxGeometry(0.42, 1.65, 0.42);
    link2Geom.translate(0, 0.825, 0);
    j2.add(new THREE.Mesh(link2Geom, accentMat));

    // Joint 3: Wrist Pitch (Z axis)
    const j3 = new THREE.Group();
    j3.position.set(0, 1.65, 0);
    j2.add(j3);
    const wristHub = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.48, 14), darkMat);
    wristHub.rotation.x = Math.PI / 2;
    j3.add(wristHub);

    // Joint 4: Solar Panel Fine Roll (Y axis)
    const j4 = new THREE.Group();
    j4.position.set(0, 0.35, 0);
    j3.add(j4);

    // Solar Panel Array on End-Effector
    const frame = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.16, 2.5), darkMat);
    frame.castShadow = true;
    const cellsGeom = new THREE.PlaneGeometry(3.75, 2.25);
    cellsGeom.rotateX(-Math.PI / 2);
    const cellsMat = new THREE.MeshStandardMaterial({
      color: 0x1d4ed8,
      emissive: 0x0b3d91,
      emissiveIntensity: 0.55,
      metalness: 0.7,
      roughness: 0.2
    });
    const cells = new THREE.Mesh(cellsGeom, cellsMat);
    cells.position.y = 0.09;
    frame.add(cells);

    this.solarFrameMesh = frame;
    this.solarCellsMesh = cells;
    j4.add(frame);

    this.armJoints = [j0, j1, j2, j3, j4];
    this.surfaceGroup.add(this.landerGroup);

    this._buildSolarSkyDome();
    const initTrack = this.computeSunTrackingAngles(this.sunAzimuthDeg, this.sunElevationDeg, 0.5, true);
    this.updateArmJoints(initTrack, true);
  }

  /**
   * Computes the local 3D sky position of the Sun above the Lander for normalized 7-day arc t in [0..1].
   * Calcula la posicion 3D del Sol sobre el modulo lunar para el arco normalizado de 7 dias t en [0..1].
   */
  _getSurfaceSunLocalOffset(normArc) {
    const t = Math.max(0, Math.min(1, normArc));
    const sweepAngle = (t - 0.5) * 1.48; // Sweeps -42.4 deg (left) to +42.4 deg (right)
    const sx = 15.5 * Math.sin(sweepAngle);
    const sy = 19.5 + 2.5 * Math.sin(t * Math.PI);
    const sz = 5.0 * Math.cos(sweepAngle);
    return new THREE.Vector3(sx, sy, sz);
  }

  /**
   * Builds the visible 3D Solar Trajectory Arc, 3D Surface Sun, and 5-Ray Panel-to-Sun Alignment Frustum.
   * Construye el arco solar 3D de 7 dias, el Sol 3D en superficie y la piramide de 5 rayos panel-Sol.
   */
  _buildSolarSkyDome() {
    this.solarDomeGroup = new THREE.Group();
    this.solarDomeGroup.position.copy(this.landerGroup.position);
    this.surfaceGroup.add(this.solarDomeGroup);

    // Green perimeter pad ring under the Lander when relocated outside the 5 predefined zones
    const padGeom = new THREE.RingGeometry(4.2, 5.1, 40);
    padGeom.rotateX(-Math.PI / 2);
    const padMat = new THREE.MeshBasicMaterial({
      color: 0x16a34a,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9
    });
    this.customPadRing = new THREE.Mesh(padGeom, padMat);
    this.customPadRing.position.set(0, -1.05, 0);
    this.customPadRing.visible = false;
    this.solarDomeGroup.add(this.customPadRing);

    // 1. 7-Day Solar Trajectory Arc (Shadow segment Days 1-3.4 + Sunlit segment Days 3.5-7.0)
    const shadowPts = [];
    const sunlitPts = [];
    const steps = 60;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const pt = this._getSurfaceSunLocalOffset(t);
      if (t <= 0.42) shadowPts.push(pt);
      if (t >= 0.40) sunlitPts.push(pt);
    }

    const shadowArcGeom = new THREE.BufferGeometry().setFromPoints(shadowPts);
    const shadowArcMat = new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.65 });
    this.solarDomeGroup.add(new THREE.Line(shadowArcGeom, shadowArcMat));

    const sunlitArcGeom = new THREE.BufferGeometry().setFromPoints(sunlitPts);
    const sunlitArcMat = new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.92 });
    this.solarDomeGroup.add(new THREE.Line(sunlitArcGeom, sunlitArcMat));

    // Endpoint & sunrise markers along the 7-day solar arc
    [0.0, 0.42, 1.0].forEach((t, idx) => {
      const mGeom = new THREE.SphereGeometry(idx === 1 ? 0.26 : 0.22, 12, 12);
      const mMat = new THREE.MeshBasicMaterial({ color: idx === 0 ? 0x94a3b8 : 0xfacc15 });
      const m = new THREE.Mesh(mGeom, mMat);
      m.position.copy(this._getSurfaceSunLocalOffset(t));
      this.solarDomeGroup.add(m);
    });

    // 2. Glowing 3D Surface Sun Sphere + Corona Halo + Outer Glow + Camera-facing Reticle Ring
    this.surfaceSunGroup = new THREE.Group();
    this.surfaceSunCoreMat = new THREE.MeshBasicMaterial({ color: 0xfde047 });
    this.surfaceSunCore = new THREE.Mesh(new THREE.SphereGeometry(1.65, 24, 24), this.surfaceSunCoreMat);
    this.surfaceSunGroup.add(this.surfaceSunCore);

    this.surfaceSunHaloMat = new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.55,
      depthWrite: false
    });
    this.surfaceSunHalo = new THREE.Mesh(new THREE.SphereGeometry(2.85, 24, 24), this.surfaceSunHaloMat);
    this.surfaceSunGroup.add(this.surfaceSunHalo);

    this.surfaceSunOuterGlow = new THREE.Mesh(
      new THREE.SphereGeometry(4.1, 24, 24),
      new THREE.MeshBasicMaterial({
        color: 0xf59e0b,
        transparent: true,
        opacity: 0.25,
        depthWrite: false
      })
    );
    this.surfaceSunGroup.add(this.surfaceSunOuterGlow);

    this.surfaceSunRingMat = new THREE.MeshBasicMaterial({
      color: 0xfef08a,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9
    });
    this.surfaceSunRing = new THREE.Mesh(new THREE.RingGeometry(3.0, 3.35, 36), this.surfaceSunRingMat);
    this.surfaceSunGroup.add(this.surfaceSunRing);
    this.solarDomeGroup.add(this.surfaceSunGroup);

    // 3. Direct 3D Panel-Normal Alignment Beam (connects Solar Panel center -> 3D Sun)
    const beamGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 6, 0),
      new THREE.Vector3(0, 15, 6)
    ]);
    this.panelNormalMat = new THREE.LineBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.95
    });
    this.panelNormalLine = new THREE.Line(beamGeom, this.panelNormalMat);
    this.solarDomeGroup.add(this.panelNormalLine);

    // Volumetric 3D laser beam cylinder between Solar Panel center and 3D Sun
    const cylGeom = new THREE.CylinderGeometry(0.055, 0.12, 1.0, 12);
    this.panelBeamMat = new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.36,
      depthWrite: false
    });
    this.panelBeamMesh = new THREE.Mesh(cylGeom, this.panelBeamMat);
    this.solarDomeGroup.add(this.panelBeamMesh);

    // Target lock ring & directional arrow cone at the tip of the panel normal vector
    this.panelLockRingMat = new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95
    });
    this.panelLockRing = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.62, 24), this.panelLockRingMat);
    this.solarDomeGroup.add(this.panelLockRing);

    this.panelArrowCone = new THREE.Mesh(new THREE.ConeGeometry(0.38, 1.15, 16), this.panelLockRingMat);
    this.solarDomeGroup.add(this.panelArrowCone);

    // 4-Corner Solar Frustum Rays connecting all 4 corners of the panel to the 3D Sun
    this.cornerRayMat = new THREE.LineBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.48
    });
    this.cornerRayLines = [];
    for (let i = 0; i < 4; i++) {
      const cGeom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 6, 0),
        new THREE.Vector3(0, 15, 6)
      ]);
      const cLine = new THREE.Line(cGeom, this.cornerRayMat);
      this.solarDomeGroup.add(cLine);
      this.cornerRayLines.push(cLine);
    }

    // Reference Sun-to-Panel line (visible when user aims away from the Sun in Manual mode)
    const refGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 6, 0),
      new THREE.Vector3(0, 15, 6)
    ]);
    this.sunRefMat = new THREE.LineBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.42
    });
    this.sunToPanelRefLine = new THREE.Line(refGeom, this.sunRefMat);
    this.solarDomeGroup.add(this.sunToPanelRefLine);

    // 4. Floating HUD badge above the 3D Surface Sun
    if (this.labelsContainer) {
      this.sunLabelEl = document.createElement("div");
      this.sunLabelEl.className = "sun-tracker-label hidden";
      this.sunLabelEl.innerHTML = `
        <div class="sun-tracker-chip">
          <span class="sun-dot"></span>
          <span class="sun-text">Sun · 1.11° · Az 146°</span>
          <span class="align-tag">Panel 100% aligned</span>
        </div>
      `;
      this.labelsContainer.appendChild(this.sunLabelEl);
    }
  }

  /**
   * Builds the 3D Water-Ice Vector, Range Beacon, and Floating Label for Cryogenic Cold Traps (<110 K).
   * Construye el vector 3D de hielo de agua, la baliza de alcance y la etiqueta flotante (<110 K).
   */
  _buildIceCorridor() {
    this.iceCorridorGroup = new THREE.Group();
    this.iceCorridorGroup.visible = false;
    this.surfaceGroup.add(this.iceCorridorGroup);

    this.psrTargets = {
      1: { px: 2459, py: 2233, name: "Connecting Ridge Micro-Cold Trap", distKm: 0.26, regionalKm: 5.61 },
      2: { px: 2020, py: 1995, name: "Shackleton Rim Cold Trap", distKm: 0.28, regionalKm: 2.62 },
      3: { px: 2447, py: 1794, name: "Inner Wall Cold Trap", distKm: 0.81, regionalKm: 3.94 },
      4: { px: 1982, py: 527,  name: "South Ridge Cold Trap", distKm: 0.80, regionalKm: 5.37 },
      5: { px: 1982, py: 527,  name: "South Ridge Cold Trap", distKm: 0.27, regionalKm: 5.59 }
    };

    // Range vector line from lander to PSR cold trap
    const lineGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const lineMat = new THREE.LineDashedMaterial({
      color: 0x38bdf8,
      dashSize: 1.5,
      gapSize: 0.8,
      transparent: true,
      opacity: 0.95
    });
    this.iceLine = new THREE.Line(lineGeom, lineMat);
    this.iceCorridorGroup.add(this.iceLine);

    // Cyan beacon marker at the cold trap
    this.iceBeaconMesh = new THREE.Group();
    const ringGeom = new THREE.RingGeometry(2.2, 3.0, 32);
    ringGeom.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
    this.iceBeaconMesh.add(new THREE.Mesh(ringGeom, ringMat));

    const poleGeom = new THREE.CylinderGeometry(0.08, 0.08, 6.0, 8);
    poleGeom.translate(0, 3.0, 0);
    const poleMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.75 });
    this.iceBeaconMesh.add(new THREE.Mesh(poleGeom, poleMat));

    const topGeom = new THREE.SphereGeometry(0.55, 16, 16);
    topGeom.translate(0, 6.2, 0);
    const topMat = new THREE.MeshBasicMaterial({ color: 0x7dd3fc });
    this.iceBeaconMesh.add(new THREE.Mesh(topGeom, topMat));

    this.iceCorridorGroup.add(this.iceBeaconMesh);

    // 3D DOM floating chip
    if (this.labelsContainer) {
      this.iceBeaconLabelEl = document.createElement("div");
      this.iceBeaconLabelEl.className = "ice-beacon-label hidden";
      this.iceBeaconLabelEl.innerHTML = `
        <div class="ice-beacon-chip">
          <span class="ice-beacon-dot"></span>
          <span class="ice-beacon-title">WATER ICE TRAP (&lt;110 K)</span>
          <span class="ice-beacon-dist">0.26 km Local · 5.6 km Regional</span>
        </div>
      `;
      this.labelsContainer.appendChild(this.iceBeaconLabelEl);
    }
  }

  updateIceCorridor(rank = 1, currentPos = null) {
    if (!this.iceCorridorGroup || !this.psrTargets) return;
    const info = this.psrTargets[rank] || this.psrTargets[1];
    const targetWorld = this._worldPosFromPixel(info.px, info.py);
    this.currentPsrWorldPos = targetWorld.clone();

    const startPos = currentPos
      ? currentPos.clone()
      : (this.landerGroup ? this.landerGroup.position.clone() : targetWorld.clone());

    const pts = [
      new THREE.Vector3(startPos.x, startPos.y + 0.5, startPos.z),
      new THREE.Vector3(targetWorld.x, targetWorld.y + 0.5, targetWorld.z)
    ];
    this.iceLine.geometry.setFromPoints(pts);
    this.iceLine.computeLineDistances();

    this.iceBeaconMesh.position.set(targetWorld.x, targetWorld.y + 0.2, targetWorld.z);

    if (this.iceBeaconLabelEl) {
      const distEl = this.iceBeaconLabelEl.querySelector(".ice-beacon-dist");
      if (distEl) {
        distEl.textContent = `${info.distKm.toFixed(2)} km Local · ${info.regionalKm.toFixed(1)} km Regional`;
      }
    }
  }

  /**
   * Clamps a 5-DOF angle array to the anatomical/mechanical limits of each physical joint
   * AND enforces coupled geometric constraints for the physical solar panel size.
   */
  clampArmAngles(angles) {
    if (!angles || angles.length < 5) return [90, 55, 60, 70, 90];
    const home = [90, 55, 60, 70, 90];
    const a = this.jointLimits.map(([minA, maxA], i) => {
      const v = Number(angles[i]);
      if (Number.isNaN(v)) return home[i];
      return Math.max(minA, Math.min(maxA, v));
    });

    // 1. Coupled Ground/Base Clearance Guard (Shoulder j1 + Elbow j2 + Wrist j3)
    const reachSum = a[1] + a[2];
    if (reachSum > 165) {
      const excess = reachSum - 165;
      a[2] = Math.max(this.jointLimits[2][0], Math.min(this.jointLimits[2][1], a[2] - excess * 0.6));
      a[1] = Math.max(this.jointLimits[1][0], Math.min(this.jointLimits[1][1], a[1] - excess * 0.4));
    }
    if ((a[1] + a[2]) > 145) {
      const maxSafeWrist = 115 - ((a[1] + a[2]) - 145) * 0.75;
      if (a[3] > maxSafeWrist) {
        a[3] = Math.max(55, Math.min(this.jointLimits[3][1], maxSafeWrist));
      }
    }

    // 2. Coupled Forearm Self-Collision Guard (when elbow is tightly flexed < 52 deg)
    if (a[2] < 52) {
      a[3] = Math.max(55, Math.min(115, a[3]));
    }

    // 3. Solar Panel Corner Roll Guard (when wrist is steeply pitched)
    if (a[3] < 58 || a[3] > 110) {
      a[4] = Math.max(55, Math.min(125, a[4]));
    }

    return a.map((v) => Math.round(v));
  }

  /**
   * Sets target 5-DOF servo angles within mechanical limits; _animate() smoothly interpolates toward them.
   * Define los 5 angulos objetivo dentro de los limites mecanicos; _animate() los interpola con suavidad.
   */
  updateArmJoints(angles, immediate = false) {
    if (!angles || angles.length < 5) return;
    const clamped = this.clampArmAngles(angles);
    for (let i = 0; i < 5; i++) {
      this._targetArmAngles[i] = clamped[i];
      if (immediate) this._currentArmAngles[i] = clamped[i];
    }
    if (immediate) this._applyArmRotations(this._currentArmAngles);
  }

  /**
   * Applies calibrated physical-to-3D joint rotations matching the 3D-printed '<' articulated arm:
   * - j0 (Base Yaw): 25..155 deg (center 90 deg)
   * - j1 (Shoulder Pitch): 35..115 deg -> t1 = (j1 - 85) deg (leans upper arm back at 55 deg for CoG balance)
   * - j2 (Elbow Flexion): 40..125 deg -> t2 = (130 - j2) deg (bends forearm forward '+' like a human elbow)
   * - j3 (Wrist Tilt): 40..135 deg -> t3 = (j3 - 90) deg (aims solar panel toward the sky/Sun)
   * - j4 (Panel Roll): 30..150 deg (center 90 deg)
   */
  _applyArmRotations(angles) {
    if (!this.armJoints || angles.length < 5) return;
    const rad = Math.PI / 180;
    this.armJoints[0].rotation.y = angles[0] * rad;
    this.armJoints[1].rotation.z = (angles[1] - 85) * rad;
    this.armJoints[2].rotation.z = (130 - angles[2]) * rad;
    this.armJoints[3].rotation.z = (angles[3] - 90) * rad;
    this.armJoints[4].rotation.y = (angles[4] - 90) * rad;
  }

  /**
   * Executes high-frequency micro-oscillation shedding routine to clear abrasive lunar regolith from the solar panel.
   * Ejecuta una rutina de micro-oscilacion para sacudir el regolito lunar electrostático del panel solar.
   */
  triggerDustSheddingRoutine(onComplete) {
    if (this._dustRoutineActive) return;
    this._dustRoutineActive = true;

    // Safe steep shedding attitude within mechanical joint limits
    const shedAngles = [90, 70, 75, 110, 90];
    this.updateArmJoints(shedAngles);

    const startTime = performance.now();
    const durationMs = 2600;

    const shakeInterval = setInterval(() => {
      const elapsed = performance.now() - startTime;
      if (elapsed >= durationMs) {
        clearInterval(shakeInterval);
        this._dustRoutineActive = false;
        const restAngles = [90, 55, 60, 70, 90];
        this.updateArmJoints(restAngles);
        if (onComplete) onComplete();
        return;
      }
      // Micro-jitter at 25 Hz simulating piezoelectric electrostatic shedding
      const j1 = (Math.random() - 0.5) * 4.0;
      const j2 = (Math.random() - 0.5) * 5.0;
      const j3 = (Math.random() - 0.5) * 6.0;
      const jittered = this.clampArmAngles([
        shedAngles[0] + j1,
        shedAngles[1] + j1,
        shedAngles[2] + j2,
        shedAngles[3] + j2,
        shedAngles[4] + j3
      ]);
      this._applyArmRotations(jittered);
    }, 40);
  }

  /**
   * Computes exact 5-DOF sun-tracking angles within safe human-arm joint limits so the 3D solar panel locks onto the Sun.
   * Calcula los 5 angulos dentro de los rangos anatomicos seguros para alinear el panel perpendicular al Sol.
   */
  computeSunTrackingAngles(sunAzimuthDeg, sunElevationDeg, progress = 0.5, sunVisible = true) {
    this.sunVisibleState = Boolean(sunVisible);
    const normArc = typeof progress === "number"
      ? Math.max(0, Math.min(1, progress))
      : Math.max(0, Math.min(1, (218.0 - sunAzimuthDeg) / 86.0));
    this.sunProgress = normArc;
    const S = this._getSurfaceSunLocalOffset(normArc);

    // Articulate shoulder (j1: 48 -> 62 deg) and elbow (j2: 52 -> 66 deg) in balanced '<' elbow posture
    const j1 = Math.round(48 + Math.sin(normArc * Math.PI) * 14);
    const j2 = Math.round(52 + Math.sin(normArc * Math.PI) * 14);

    const rad = Math.PI / 180;
    const t1 = (j1 - 85) * rad;
    const t2 = (130 - j2) * rad;

    // Exact closed-form 3-iteration inverse kinematics using L1=2.0, L2=1.65 so panel normal hits the 3D Sun
    let psi = Math.atan2(S.z, -S.x);
    let Theta = 0.45;
    for (let iter = 0; iter < 3; iter++) {
      const xj0 = -2.0 * Math.sin(t1) - 1.65 * Math.sin(t1 + t2) - 0.44 * Math.sin(Theta);
      const yj0 = 0.4 + 2.0 * Math.cos(t1) + 1.65 * Math.cos(t1 + t2) + 0.44 * Math.cos(Theta);
      const px = 1.65 * xj0 * Math.cos(psi);
      const py = 1.65 * (0.75 + yj0);
      const pz = -1.65 * xj0 * Math.sin(psi);
      const vx = S.x - px;
      const vy = S.y - py;
      const vz = S.z - pz;
      const len = Math.hypot(vx, vy, vz) || 1;
      psi = Math.atan2(vz / len, -vx / len);
      Theta = Math.acos(Math.max(-1, Math.min(1, vy / len)));
    }

    const j0 = (psi * 180) / Math.PI;
    const j3 = 90 + (Theta * 180) / Math.PI - (j1 - 85) - (130 - j2);
    // Keep j4 squarely at 90 deg so the solar panel face remains horizon-level while aiming directly at the Sun
    const j4 = 90;
    return this.clampArmAngles([j0, j1, j2, j3, j4]);
  }

  updateSunPosition(azimuthDeg, elevationDeg, sunVisible = true, progress = null) {
    this.sunAzimuthDeg = azimuthDeg;
    this.sunElevationDeg = elevationDeg;
    this.sunVisibleState = Boolean(sunVisible);

    const r = 620;
    const normArc = typeof progress === "number"
      ? Math.max(0, Math.min(1, progress))
      : (typeof this.sunProgress === "number" ? this.sunProgress : Math.max(0, Math.min(1, (218.0 - azimuthDeg) / 86.0)));
    this.sunProgress = normArc;

    const localSun = this._getSurfaceSunLocalOffset(normArc);
    if (this.viewMode === "surface") {
      // Align terrain directional sunlight azimuth with the visible 3D Sun while keeping realistic polar grazing shadows
      const horizDist = Math.hypot(localSun.x, localSun.z) || 1;
      const dir = new THREE.Vector3(localSun.x, horizDist * 0.22, localSun.z);
      dir.normalize().multiplyScalar(r);
      this.sunLight.position.copy(dir);
      this.sunSphere.visible = false;
    } else {
      const visualAzDeg = 110 + normArc * 145;
      const az = (visualAzDeg * Math.PI) / 180;
      const elevVis = Math.max(8, elevationDeg * 8);
      const el = (elevVis * Math.PI) / 180;

      const x = r * Math.cos(el) * Math.sin(az);
      const y = r * Math.sin(el);
      const z = -r * Math.cos(el) * Math.cos(az);

      this.sunLight.position.set(x, y, z);
      this.sunSphere.visible = true;
      this.sunSphere.position.set(
        -240 + normArc * 120,
        110 + 25 * Math.sin(normArc * Math.PI),
        -380
      );
    }

    if (this.surfaceSunGroup) {
      this.surfaceSunGroup.position.copy(localSun);
      this.surfaceSunCoreMat.color.setHex(0xfde047);
      this.surfaceSunHaloMat.color.setHex(0xfacc15);
      this.surfaceSunHaloMat.opacity = 0.55;
      this.surfaceSunRingMat.color.setHex(0xfef08a);
    }
  }

  /**
   * Updates the 3D Panel-to-Sun alignment pyramid, floating HUD badge, and 3D zone labels every frame.
   * Actualiza en cada cuadro la piramide de alineacion Panel-Sol, la etiqueta solar y los 5 badges de zona.
   */
  _updateSolarTrackingVisuals() {
    if (!this.solarDomeGroup || !this.surfaceSunGroup) return;

    if (this.viewMode !== "surface") {
      if (this.sunLabelEl) this.sunLabelEl.classList.add("hidden");
      if (this.zoneLabelEls) {
        this.zoneLabelEls.forEach((item) => item.el.classList.add("hidden"));
      }
      return;
    }

    this.landerGroup.updateMatrixWorld(true);
    this.solarDomeGroup.updateMatrixWorld(true);

    const rad = Math.PI / 180;
    const a = this._currentArmAngles;
    const psi = a[0] * rad;
    const t1 = (a[1] - 85) * rad;
    const t2 = (130 - a[2]) * rad;
    const t3 = (a[3] - 90) * rad;
    const Theta = t1 + t2 + t3;

    // Exact panel center P and unit normal N in solarDomeGroup coordinates (L1=2.0, L2=1.65)
    const xj0 = -2.0 * Math.sin(t1) - 1.65 * Math.sin(t1 + t2) - 0.44 * Math.sin(Theta);
    const yj0 = 0.4 + 2.0 * Math.cos(t1) + 1.65 * Math.cos(t1 + t2) + 0.44 * Math.cos(Theta);
    const P = new THREE.Vector3(
      1.65 * xj0 * Math.cos(psi),
      1.65 * (0.75 + yj0),
      -1.65 * xj0 * Math.sin(psi)
    );
    const N = new THREE.Vector3(
      -Math.sin(Theta) * Math.cos(psi),
      Math.cos(Theta),
      Math.sin(Theta) * Math.sin(psi)
    ).normalize();

    const S = this.surfaceSunGroup.position;
    const toSun = S.clone().sub(P);
    const dist = toSun.length() || 1;
    const sunDir = toSun.clone().divideScalar(dist);

    const tip = P.clone().add(N.clone().multiplyScalar(dist));
    this.panelNormalLine.geometry.setFromPoints([P, tip]);
    this.sunToPanelRefLine.geometry.setFromPoints([P, S]);

    if (this.panelBeamMesh) {
      const mid = P.clone().add(tip).multiplyScalar(0.5);
      this.panelBeamMesh.position.copy(mid);
      this.panelBeamMesh.scale.set(1, dist, 1);
      this.panelBeamMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), N);
    }

    if (this.panelArrowCone) {
      const coneDist = Math.max(1.8, dist - 3.1);
      const conePos = P.clone().add(N.clone().multiplyScalar(coneDist));
      this.panelArrowCone.position.copy(conePos);
      this.panelArrowCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), N);
    }

    this.panelLockRing.position.copy(tip);
    this.panelLockRing.lookAt(this.camera.position);
    this.surfaceSunRing.lookAt(this.camera.position);

    const cosAlign = Math.max(0, Math.min(1, N.dot(sunDir)));
    const alignPct = Math.round(cosAlign * 100);
    const isLocked = alignPct >= 98;

    this.panelNormalMat.color.setHex(isLocked ? 0xfacc15 : 0x38bdf8);
    if (this.panelBeamMat) this.panelBeamMat.color.setHex(isLocked ? 0xfacc15 : 0x38bdf8);
    this.panelLockRingMat.color.setHex(isLocked ? 0xfacc15 : 0x38bdf8);
    this.sunToPanelRefLine.visible = !isLocked;

    if (this.cornerRayLines && this.cornerRayLines.length === 4 && this.solarFrameMesh) {
      const corners = [
        new THREE.Vector3(-1.85, 0.1, -1.1),
        new THREE.Vector3(1.85, 0.1, -1.1),
        new THREE.Vector3(1.85, 0.1, 1.1),
        new THREE.Vector3(-1.85, 0.1, 1.1)
      ];
      corners.forEach((cLocal, idx) => {
        const cWorld = cLocal.clone().applyMatrix4(this.solarFrameMesh.matrixWorld);
        const cDome = this.solarDomeGroup.worldToLocal(cWorld);
        this.cornerRayLines[idx].geometry.setFromPoints([cDome, S]);
      });
      if (this.cornerRayMat) {
        this.cornerRayMat.color.setHex(isLocked ? 0xfacc15 : 0x94a3b8);
        this.cornerRayMat.opacity = isLocked ? 0.5 : 0.2;
      }
    }

    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    if (this.sunLabelEl) {
      if (this.labelsContainer && !this.labelsContainer.contains(this.sunLabelEl)) {
        this.labelsContainer.appendChild(this.sunLabelEl);
      }
      const worldSun = this.surfaceSunGroup.getWorldPosition(new THREE.Vector3());
      const proj = worldSun.clone().project(this.camera);
      if (proj.z > 1) {
        this.sunLabelEl.classList.add("hidden");
      } else {
        const sunText = this.sunLabelEl.querySelector(".sun-text");
        const alignTag = this.sunLabelEl.querySelector(".align-tag");
        const sunDot = this.sunLabelEl.querySelector(".sun-dot");
        if (sunText) {
          sunText.textContent = `${this.sunVisibleState ? "Sun visible" : "Sun behind ridge"} · ${this.sunElevationDeg.toFixed(2)}° · Az ${Math.round(this.sunAzimuthDeg)}°`;
        }
        if (alignTag) {
          alignTag.textContent = `Panel ${alignPct}% aligned`;
          alignTag.style.color = isLocked ? "#fde047" : "#38bdf8";
        }
        if (sunDot) {
          sunDot.style.background = this.sunVisibleState ? "#facc15" : "#94a3b8";
        }

        this.sunLabelEl.classList.remove("hidden");

        // Keep the floating sun pill strictly inside the clear center channel between #panel-left and #panel-right
        const rawX = (proj.x * 0.5 + 0.5) * w;
        const gapMargin = 16;
        const panelLeftEnd = w <= 1280 ? 306 : 336;
        const panelRightStart = w <= 1280 ? w - 326 : w - 356;
        const labelHalfW = Math.max(166, (this.sunLabelEl.offsetWidth || 328) * 0.5);
        const minCenterX = panelLeftEnd + gapMargin + labelHalfW;
        const maxCenterX = panelRightStart - gapMargin - labelHalfW;
        const sx = minCenterX <= maxCenterX
          ? Math.max(minCenterX, Math.min(maxCenterX, rawX))
          : (panelLeftEnd + panelRightStart) * 0.5;
        const sy = Math.max(152, (-proj.y * 0.5 + 0.5) * h - 30);

        this.sunLabelEl.style.left = `${sx}px`;
        this.sunLabelEl.style.top = `${sy}px`;
      }
    }

    if (this.zoneLabelEls && this.zoneLabelEls.length) {
      this.zoneLabelEls.forEach((item) => {
        if (this.labelsContainer && !this.labelsContainer.contains(item.el)) {
          this.labelsContainer.appendChild(item.el);
        }
        const isHere = item.zone.rank === this.activeZoneRank;
        if (!this.showZones && !isHere) {
          item.el.classList.add("hidden");
          return;
        }
        const anchor = isHere
          ? this.landerGroup.position.clone().add(new THREE.Vector3(0, -1.9, 0))
          : item.worldPos.clone().add(new THREE.Vector3(0, 10.8, 0));
        const pProj = anchor.project(this.camera);
        if (pProj.z > 1) {
          item.el.classList.add("hidden");
          return;
        }
        const zx = (pProj.x * 0.5 + 0.5) * w;
        const zy = (-pProj.y * 0.5 + 0.5) * h;
        const outOfCanvas = zx < 340 || zx > w - 360 || zy < 76 || zy > h - 108;
        if (!isHere && outOfCanvas) {
          item.el.classList.add("hidden");
          return;
        }
        item.el.classList.remove("hidden");
        item.el.style.left = `${Math.max(360, Math.min(w - 380, zx))}px`;
        item.el.style.top = `${Math.max(90, Math.min(h - 142, zy))}px`;
      });
    }

    if (this.iceBeaconLabelEl && this.iceCorridorGroup && this.iceCorridorGroup.visible && this.currentPsrWorldPos) {
      if (this.labelsContainer && !this.labelsContainer.contains(this.iceBeaconLabelEl)) {
        this.labelsContainer.appendChild(this.iceBeaconLabelEl);
      }
      const anchor = this.currentPsrWorldPos.clone().add(new THREE.Vector3(0, 6.8, 0));
      const bProj = anchor.project(this.camera);
      if (bProj.z > 1) {
        this.iceBeaconLabelEl.classList.add("hidden");
      } else {
        this.iceBeaconLabelEl.classList.remove("hidden");
        const bx = (bProj.x * 0.5 + 0.5) * w;
        const by = (-bProj.y * 0.5 + 0.5) * h;
        this.iceBeaconLabelEl.style.left = `${Math.max(340, Math.min(w - 360, bx))}px`;
        this.iceBeaconLabelEl.style.top = `${Math.max(80, Math.min(h - 120, by))}px`;
      }
    } else if (this.iceBeaconLabelEl) {
      this.iceBeaconLabelEl.classList.add("hidden");
    }
  }

  /**
   * Transitions reliably to the 3D LOLA surface view, canceling any pending transition.
   * Transiciona de forma segura a la superficie LOLA 3D, cancelando transiciones previas.
   */
  flyToSurface(onComplete) {
    if (this._transitionTimer) {
      clearTimeout(this._transitionTimer);
      this._transitionTimer = null;
    }
    this._camTween = null;

    if (this.viewMode === "surface") {
      this.fadeEl.classList.remove("on");
      if (onComplete) onComplete();
      return;
    }

    this.fadeEl.classList.add("on");
    this._transitionTimer = setTimeout(() => {
      this._transitionTimer = null;
      this.viewMode = "surface";
      this.globeGroup.visible = false;
      this.surfaceGroup.visible = true;

      this.controls.minDistance = 8;
      this.controls.maxDistance = 420;
      this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
      this.sunLight.intensity = 1.65;

      const target = this._landerTargetPos
        ? this._landerTargetPos.clone()
        : (this.landerGroup ? this.landerGroup.position.clone() : new THREE.Vector3(68, 41, 49));
      this.controls.target.set(target.x, target.y + 8.0, target.z);
      this.camera.position.set(target.x, target.y + 15.5, target.z + 78.0);
      this.controls.update();
      this.updateSunPosition(this.sunAzimuthDeg, this.sunElevationDeg, this.sunVisibleState);

      this.fadeEl.classList.remove("on");
      if (onComplete) onComplete();
    }, 320);
  }

  /**
   * Transitions reliably back to the full 3D Moon Globe in space.
   * Regresa de forma segura a la vista de la Luna completa en el espacio.
   */
  flyToGlobe(onComplete) {
    if (this._transitionTimer) {
      clearTimeout(this._transitionTimer);
      this._transitionTimer = null;
    }
    this._camTween = null;

    if (this.viewMode === "globe") {
      this.fadeEl.classList.remove("on");
      if (onComplete) onComplete();
      return;
    }

    this.fadeEl.classList.add("on");
    this._transitionTimer = setTimeout(() => {
      this._transitionTimer = null;
      this.viewMode = "globe";
      this.surfaceGroup.visible = false;
      this.globeGroup.visible = true;
      if (this.sunLabelEl) this.sunLabelEl.classList.add("hidden");
      if (this.zoneLabelEls) this.zoneLabelEls.forEach((item) => item.el.classList.add("hidden"));

      this.sunLight.intensity = 1.75;
      this.controls.maxPolarAngle = Math.PI;
      this.controls.minDistance = 120;
      this.controls.maxDistance = 420;
      this.controls.target.set(0, 0, 0);
      this.camera.position.set(0, 0, 285);
      this.controls.update();
      this.updateSunPosition(this.sunAzimuthDeg, this.sunElevationDeg, this.sunVisibleState);

      this.fadeEl.classList.remove("on");
      if (onComplete) onComplete();
    }, 320);
  }

  /**
   * Relocates the Lander & Arm to the selected Artemis candidate site sector (0..3) and frames it.
   * Reubica el modulo y brazo en el sitio candidato Artemis elegido (0..3) y lo enfoca.
   */
  focusOnCandidateSite(siteIdx) {
    if (siteIdx === 0 && this.zonesData && this.zonesData.length > 0) {
      this.focusOnZone(this.zonesData[0]);
      return;
    }
    const coord = this.siteSurfaceCoords[siteIdx] || this.siteSurfaceCoords[0];
    const p = this._worldPosFromPixel(coord.px, coord.py);
    this.relocateLanderTo(p, null, true);
    this.focusOnArm(true);
  }

  /**
   * Focuses the camera on the 3D Lander, 5-DOF Robotic Arm, 3D Sun Trajectory Arc, and terrain.
   * Enfoca la camara sobre el modulo lunar, el brazo robotico de 5 ejes, el arco solar y el terreno.
   */
  focusOnArm(force = false) {
    if (!this.landerGroup) return;
    const p = (this._landerTargetPos || this.landerGroup.position).clone();
    const newTarget = p.clone().add(new THREE.Vector3(0, 8.0, 0));
    const curOffset = this.camera.position.clone().sub(this.controls.target);
    const idealPos = (this.viewMode === "surface" && curOffset.length() > 78.0)
      ? newTarget.clone().add(curOffset)
      : p.clone().add(new THREE.Vector3(0, 15.5, 78.0));
    if (force || this.camera.position.distanceTo(idealPos) > 10) {
      this._tweenCamera(idealPos, newTarget, 600);
    }
  }

  focusOnZone(zone) {
    if (!zone) return;
    const p = this._worldPosFromPixel(zone.pixel_x, zone.pixel_y);
    this.relocateLanderTo(p, zone.rank, true);
    this.focusOnArm(true);
  }

  resetCamera() {
    if (this.viewMode === "globe") {
      this._globeTargetYaw = 0.0;
      this._tweenCamera(new THREE.Vector3(0, 0, 285), new THREE.Vector3(0, 0, 0), 650);
    } else {
      const target = (this._landerTargetPos || (this.landerGroup ? this.landerGroup.position : new THREE.Vector3(68, 41, 49))).clone();
      this._tweenCamera(new THREE.Vector3(target.x, target.y + 15.5, target.z + 78.0), new THREE.Vector3(target.x, target.y + 8.0, target.z), 650);
    }
  }

  _tweenCamera(toPos, toTarget, durationMs = 650, onDone = null) {
    this._camTween = {
      fromPos: this.camera.position.clone(),
      toPos: toPos.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: toTarget.clone(),
      start: performance.now(),
      duration: durationMs,
      onDone
    };
  }

  _updateLabels() {
    if (!this.globePins.length) return;
    if (this.viewMode !== "globe") {
      this.globePins.forEach((p) => p.el.classList.add("hidden"));
      return;
    }
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const camDir = this.camera.position.clone().normalize();

    this.globePins.forEach((p) => {
      const worldPos = p.mesh.getWorldPosition(new THREE.Vector3());
      const normal = worldPos.clone().normalize();
      const facing = normal.dot(camDir) > 0.05;

      if (!facing) {
        p.el.classList.add("hidden");
        return;
      }
      const proj = worldPos.clone().project(this.camera);
      const x = (proj.x * 0.5 + 0.5) * w;
      const y = (-proj.y * 0.5 + 0.5) * h;
      p.el.classList.remove("hidden");
      p.el.style.left = `${x}px`;
      p.el.style.top = `${y}px`;
    });
  }

  _onResize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _animate() {
    requestAnimationFrame(() => this._animate());

    if (this._camTween) {
      const t = Math.min(1, (performance.now() - this._camTween.start) / this._camTween.duration);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.camera.position.lerpVectors(this._camTween.fromPos, this._camTween.toPos, ease);
      this.controls.target.lerpVectors(this._camTween.fromTarget, this._camTween.toTarget, ease);
      if (t >= 1) {
        const done = this._camTween.onDone;
        this._camTween = null;
        if (done) done();
      }
    }

    // Animated parabolic hop when relocating Lander, 5-DOF Arm, Solar Panel & Solar Dome
    if (this._landerTween) {
      const t = Math.min(1, (performance.now() - this._landerTween.start) / this._landerTween.duration);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.landerGroup.position.lerpVectors(this._landerTween.from, this._landerTween.to, ease);
      this.landerGroup.position.y += Math.sin(ease * Math.PI) * 4.5;
      if (this.solarDomeGroup) {
        this.solarDomeGroup.position.copy(this.landerGroup.position);
      }
      if (t >= 1) {
        this.landerGroup.position.copy(this._landerTween.to);
        if (this.solarDomeGroup) {
          this.solarDomeGroup.position.copy(this._landerTween.to);
        }
        this._landerTween = null;
      }
    }

    // Responsive 5-DOF robotic arm joint animation (zero lag during sun tracking)
    let armMoved = false;
    for (let i = 0; i < 5; i++) {
      const diff = this._targetArmAngles[i] - this._currentArmAngles[i];
      if (Math.abs(diff) > 0.05) {
        this._currentArmAngles[i] += diff * 0.35;
        armMoved = true;
      } else {
        this._currentArmAngles[i] = this._targetArmAngles[i];
      }
    }
    if (armMoved) {
      this._applyArmRotations(this._currentArmAngles);
    }

    // Gentle south-polar globe orientation so site chips stay in front view
    if (this.viewMode === "globe" && this.moonSphere) {
      this._globeBaseYaw += (this._globeTargetYaw - this._globeBaseYaw) * 0.08;
      const breath = Math.sin(performance.now() * 0.0003) * 0.04;
      this.moonSphere.rotation.y = this._globeBaseYaw + breath;
    }

    if (this.earthMesh) {
      this.earthMesh.rotation.y += 0.0007;
    }

    this.controls.update();
    this._updateSolarTrackingVisuals();
    this.renderer.render(this.scene, this.camera);
    this._updateLabels();
  }
}

window.LunarDigitalTwin = LunarDigitalTwin;
