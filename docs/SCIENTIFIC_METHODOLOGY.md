# Planetary Science & Engineering Methodology

This document details the scientific formulation, data sources, multi-criteria decision framework, and solar geometry physics powering the **Lunar Landing Site Navigator**.

---

## 1. NASA Planetary Data Sources

| Scientific Dataset | Mission / Instrument | Agency | Resolution / Metric | Scientific Application |
|---|---|---|---|---|
| **LOLA DEM** | Lunar Reconnaissance Orbiter (LOLA) | NASA GSFC | 20 m/px polar altimetry | Topographic slope, elevation, surface roughness, 3D mesh |
| **Diviner Thermal** | LRO Diviner Radiometer | UCLA / NASA JPL | 128 px/deg bolometric temp (K) | Identification of cryogenic PSR cold traps (<40 K) and thermal extremes |
| **LEND Epithermal** | Lunar Exploration Neutron Detector | Space Research Institute (IKI) / NASA | Hydrogen proxy count rate | Subsurface water-ice volatiles estimation |
| **JPL Horizons** | Solar System Dynamics Group | NASA JPL | Sub-arcsecond vector precision | 7-day polar Sun and Earth azimuth/elevation ephemerides |
| **LROC WAC Basemap**| Lunar Reconnaissance Orbiter Camera | ASU / NASA GSFC | 100 m/px optical albedo | 3D Moon digital twin globe photorealistic texture |

---

## 2. Topographic Slope & Surface Roughness Derivation

### Gradient & Slope Calculation
Using a 3×3 moving kernel over the LOLA elevation raster $Z(x, y)$ at grid spacing $\Delta x = \Delta y$:

$$\frac{\partial Z}{\partial x} \approx \frac{(Z_{i+1, j-1} + 2 Z_{i+1, j} + Z_{i+1, j+1}) - (Z_{i-1, j-1} + 2 Z_{i-1, j} + Z_{i-1, j+1})}{8 \Delta x}$$

$$\frac{\partial Z}{\partial y} \approx \frac{(Z_{i-1, j+1} + 2 Z_{i, j+1} + Z_{i+1, j+1}) - (Z_{i-1, j-1} + 2 Z_{i, j-1} + Z_{i+1, j-1})}{8 \Delta y}$$

The local topographic slope $\theta$ is:
$$\theta = \arctan\left(\sqrt{\left(\frac{\partial Z}{\partial x}\right)^2 + \left(\frac{\partial Z}{\partial y}\right)^2}\right)$$

### Surface Roughness (RMS Height Deviation)
Surface roughness $\sigma_z$ over a landing footprint window of radius $R = 100\,\text{m}$ ($N$ elevation samples) evaluates sub-kilometer mechanical hazards (boulders, micro-craters):
$$\sigma_z = \sqrt{\frac{1}{N} \sum_{k=1}^N (Z_k - \bar{Z})^2}$$

---

## 3. Multi-Criteria Decision Analysis (MCDA) Scoring

To evaluate candidate landing zones objectively, the platform employs a weighted additive utility function normalized between 0 and 100:

$$\text{Composite Score} = \sum_{i=1}^m w_i \cdot S_i$$

Where $\sum w_i = 1.0$:

| Criterion | Weight ($w_i$) | Normalized Function $S_i$ | Operational Significance |
|---|:---:|---|---|
| **Landing Safety (Slope & Roughness)** | **0.35** | $S = 100 \cdot \max\left(0, 1 - \frac{\theta}{\theta_{\max}}\right) \cdot \exp\left(-\frac{\sigma_z}{0.2}\right)$ | Lander tip-over hazard mitigation ($\theta < 5^\circ$) |
| **Solar Illumination Availability** | **0.25** | $S = 100 \cdot \frac{T_{\text{sun}}}{T_{\text{total}}}$ | Photovoltaic generation during mission window |
| **Direct-to-Earth (DTE) Line of Sight** | **0.20** | $S = 100 \cdot \frac{T_{\text{DTE}}}{T_{\text{total}}}$ | Uninterrupted telemetry and high-bandwidth telecom |
| **Water-Ice / Volatiles Proximity** | **0.10** | $S = 100 \cdot \frac{1}{1 + d_{\text{PSR}} / d_{\text{nominal}}}$ | In-Situ Resource Utilization (ISRU) accessibility |
| **Thermal Stability** | **0.10** | $S = 100 \cdot \left(1 - \frac{|T_{\text{peak}} - T_{\text{mean}}|}{150}\right)$ | Electronic subsystem survivability |

---

## 4. Solar Tracking Advantage: Mathematical Physics

### Polar Solar Geometry
At lunar south polar latitudes ($\lambda \approx 89.4^\circ\text{ S}$), the Moon's axial tilt of only $1.54^\circ$ causes the Sun to hover near the horizon throughout the lunar day, with solar elevation angles typically ranging between:
$$\alpha_{\text{sun}} \in [0.8^\circ, 1.5^\circ]$$

### Horizontal Fixed Solar Panel vs. 5-DOF Articulated Tracking

#### Scenario A: Fixed Horizontal Solar Panel
For a panel lying flat on top of the lander chassis ($\hat{n} = [0, 0, 1]^T$ in the local topocentric frame):
$$I_{\text{fixed}} = I_0 \cdot \sin(\alpha_{\text{sun}})$$
For a typical elevation of $\alpha_{\text{sun}} = 1.1^\circ$:
$$\sin(1.1^\circ) \approx 0.0192$$
$$I_{\text{fixed}} = 1361\,\text{W/m}^2 \times 0.0192 \approx 26.1\,\text{W/m}^2$$

Over a 7-day lunar polar mission window (168 hours) with grazing shadows:
$$E_{\text{fixed}} \approx 315\,\text{Wh}$$

#### Scenario B: 5-DOF Articulated Tracking Panel
Using closed-form inverse kinematics, the 5-DOF robotic arm rotates the panel normal $\hat{n}_{\text{panel}}$ to remain directly antiparallel to the incoming solar ray $\hat{s}_{\text{sun}}$:
$$\hat{n}_{\text{panel}} \cdot \hat{s}_{\text{sun}} = \cos(0^\circ) = 1.000$$
$$I_{\text{tracked}} = I_0 \cdot \cos(0^\circ) = 1361\,\text{W/m}^2 \times 1.000 = 1361\,\text{W/m}^2$$

Accounting for local ridge horizon masking:
$$E_{\text{tracked}} \approx 15,795\,\text{Wh}$$

### Net Multiplication Factor
$$\text{Multiplication Factor} = \frac{E_{\text{tracked}}}{E_{\text{fixed}}} = \frac{15,795\,\text{Wh}}{315\,\text{Wh}} \approx \mathbf{50.1\times}$$

This **50.1-fold increase** in harvested energy enables the lander to keep internal cryogenic heaters operating continuously, maintaining battery State of Charge (SoC) well above critical thresholds throughout shadowed transit periods.
