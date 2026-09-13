const DEFAULT_ZOOM = 19;
const MAX_ZOOM = 22;
const POLL_MS = 8000;
const API_PATH = "/api/sheet";
const DIRECT_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycby8sXiPEIWwS84rly0e5jSATF5qRgmIcvussuH0zAJRJ0SsMhrP0vcto8ATXLAv0IkrCg/exec";
const VIEW_CACHE_KEY = "mat-orientation-map-view-v1";
const AUTH_CACHE_KEY = "mat-orientation-map-auth-v1";
/** Yard Beach bearing reference (Casablanca Port: 330° NW facing the ocean/basin). Beach strictly = 12h */
const DEFAULT_BEACH_BEARING = 330;
const BEACH_BEARING_CACHE_KEY = "mat_beach_bearing";

function readBeachBearingCache() {
  try {
    const raw = localStorage.getItem(BEACH_BEARING_CACHE_KEY);
    if (raw != null) {
      const num = Number(raw);
      if (Number.isFinite(num)) {
        return ((Math.round(num) % 360) + 360) % 360;
      }
    }
  } catch {}
  return DEFAULT_BEACH_BEARING;
}

function getBearingCompassText(deg) {
  const normalized = ((Math.round(deg) % 360) + 360) % 360;
  const directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const index = Math.round((normalized / 22.5)) % 16;
  return `${normalized}° ${directions[index]}`;
}

const state = {
  map: null,
  layer: null,
  mats: [],
  selectedMatId: null,
  pollTimer: null,
  lastUpdatedAt: null,
  toastTimer: null,
  _didFit: false,
  _restoring: false,
  _mapReady: false,
  auth: readAuthCache(),
  pending: Object.create(null),
  beachBearing: readBeachBearingCache(),
  horlogeMode: "adapted", // "adapted" (rotates with compass towards beach) | "normal" (fixed 12h en haut)
  horlogeOpen: false,
  searchQuery: "",
  searchResults: [],
  closestMatId: null,
  gps: {
    watching: false,
    watchId: null,
    lat: null,
    lng: null,
    accuracy: null,
    heading: null,
    marker: null,
    circle: null,
    distanceLine: null,
    error: null,
  },
  compass: {
    watching: false,
    heading: null,
    estimatedClock: null,
    error: null,
    _onOrientation: null,
  },
};

const els = {
  loginScreen: document.querySelector("#login-screen"),
  loginForm: document.querySelector("#login-form"),
  loginUser: document.querySelector("#login-user"),
  loginPass: document.querySelector("#login-pass"),
  loginError: document.querySelector("#login-error"),
  loginSubmit: document.querySelector("#login-submit"),
  app: document.querySelector("#app"),
  status: document.querySelector("#sync-status"),
  zoomLevel: document.querySelector("#zoom-level"),
  authUser: document.querySelector("#auth-user"),
  refresh: document.querySelector("#btn-refresh"),
  fit: document.querySelector("#btn-fit"),
  logout: document.querySelector("#btn-logout"),
  // Topbar actions
  btnGpsToggle: document.querySelector("#btn-gps-toggle"),
  btnHorlogeToggle: document.querySelector("#btn-horloge-toggle"),
  // Search
  searchInput: document.querySelector("#mat-search-input"),
  searchClear: document.querySelector("#btn-search-clear"),
  searchDropdown: document.querySelector("#search-dropdown"),
  // Real-Time Closest MAT Pill
  closestMatPill: document.querySelector("#closest-mat-pill"),
  closestMatName: document.querySelector("#closest-mat-name"),
  closestMatDist: document.querySelector("#closest-mat-dist"),
  // Floating Horloge
  floatingHorloge: document.querySelector("#floating-horloge"),
  btnHorlogeClose: document.querySelector("#btn-horloge-close"),
  btnModeAdapted: document.querySelector("#btn-mode-adapted"),
  btnModeNormal: document.querySelector("#btn-mode-normal"),
  btnCalibrateCompass: document.querySelector("#btn-calibrate-compass"),
  horlogeBeachValue: document.querySelector("#horloge-beach-value"),
  btnBearingMinus: document.querySelector("#btn-bearing-minus"),
  btnBearingPlus: document.querySelector("#btn-bearing-plus"),
  btnBearingCustom: document.querySelector("#btn-bearing-custom"),
  horlogeRotatingDial: document.querySelector("#horloge-rotating-dial"),
  horlogeAimValue: document.querySelector("#horloge-aim-value"),
  horlogeHeadingValue: document.querySelector("#horloge-heading-value"),
  horlogeFooterHint: document.querySelector("#horloge-footer-hint"),
  // Drawer
  drawer: document.querySelector("#drawer"),
  drawerTitle: document.querySelector("#drawer-title"),
  drawerMeta: document.querySelector("#drawer-meta"),
  drawerDistance: document.querySelector("#drawer-distance"),
  drawerModeBtn: document.querySelector("#drawer-mode-btn"),
  drawerBeachBtn: document.querySelector("#drawer-beach-btn"),
  drawerBody: document.querySelector("#drawer-body"),
  drawerClose: document.querySelector("#drawer-close"),
  toast: document.querySelector("#toast"),
  navPad: document.querySelector("#map-nav-pad"),
};

els.refresh?.addEventListener("click", () => loadSheet(true));
els.fit?.addEventListener("click", () => {
  fitMap();
  toast("Vue ajustée sur tous les MATs");
});
els.logout?.addEventListener("click", logout);
els.drawerClose?.addEventListener("click", closeDrawer);
els.btnGpsToggle?.addEventListener("click", () => toggleGps());
els.btnHorlogeToggle?.addEventListener("click", () => toggleHorlogeWidget());
els.btnHorlogeClose?.addEventListener("click", () => toggleHorlogeWidget(false));
els.btnModeAdapted?.addEventListener("click", () => setHorlogeMode("adapted"));
els.btnModeNormal?.addEventListener("click", () => setHorlogeMode("normal"));
els.drawerModeBtn?.addEventListener("click", () => toggleHorlogeMode());
els.drawerBeachBtn?.addEventListener("click", handleDrawerBeachClick);
els.closestMatPill?.addEventListener("click", () => {
  if (state.closestMatId) {
    openDrawer(state.closestMatId, { focus: true });
    toast(`📍 Navigation vers MAT ${state.closestMatId}`);
  }
});

els.btnCalibrateCompass?.addEventListener("click", () => void calibrateBeachToCurrentHeading());
els.btnBearingMinus?.addEventListener("click", () => setBeachBearing(state.beachBearing - 5));
els.btnBearingPlus?.addEventListener("click", () => setBeachBearing(state.beachBearing + 5));
els.btnBearingCustom?.addEventListener("click", promptCustomBearing);
document.querySelectorAll(".horloge-calibrate-section .preset-chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    const b = Number(btn.dataset.bearing);
    if (Number.isFinite(b)) setBeachBearing(b);
  });
});

// Search Listeners
els.searchInput?.addEventListener("input", handleSearchInput);
els.searchInput?.addEventListener("focus", handleSearchInput);
els.searchInput?.addEventListener("keydown", handleSearchKeydown);
els.searchClear?.addEventListener("click", clearSearch);
document.addEventListener("click", (e) => {
  if (!e.target.closest?.(".search-container")) closeSearchDropdown();
});

els.navPad?.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-pan]");
  if (!button) return;
  event.preventDefault();
  panMap(button.dataset.pan);
});
els.loginForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  void handleLogin();
});

bootstrap();

async function bootstrap() {
  if (state.auth?.token && state.auth?.user) {
    showApp();
    startMapApp();
    return;
  }
  showLogin();
}

function showLogin() {
  if (els.loginScreen) els.loginScreen.hidden = false;
  if (els.app) els.app.hidden = true;
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function showApp() {
  if (els.loginScreen) els.loginScreen.hidden = true;
  if (els.app) els.app.hidden = false;
  if (els.authUser) els.authUser.textContent = state.auth?.user || "";
}

function startMapApp() {
  updateBeachDisplay();
  if (!state._mapReady) {
    initMap();
    state._mapReady = true;
  } else {
    setTimeout(() => state.map?.invalidateSize(), 50);
  }
  loadSheet(true);
  if (!state.pollTimer) {
    state.pollTimer = setInterval(() => loadSheet(false), POLL_MS);
  }
}

async function handleLogin() {
  const user = String(els.loginUser?.value || "").trim();
  const pass = String(els.loginPass?.value || "");
  if (!user || !pass) return;
  if (els.loginError) {
    els.loginError.hidden = true;
    els.loginError.textContent = "";
  }
  if (els.loginSubmit) els.loginSubmit.disabled = true;
  try {
    const payload = await postSheet({ mode: "login", user, pass }, { auth: false });
    if (!payload.ok || !payload.token) throw new Error(payload.error || "Login failed");
    state.auth = {
      user: payload.user || user,
      pass,
      token: payload.token,
      expiresAt: payload.expiresAt || null,
    };
    writeAuthCache(state.auth);
    if (els.loginPass) els.loginPass.value = "";
    showApp();
    startMapApp();
    toast(`Signed in as ${state.auth.user}`);
  } catch (error) {
    if (els.loginError) {
      els.loginError.hidden = false;
      els.loginError.textContent = error.message || "Login failed";
    }
  } finally {
    if (els.loginSubmit) els.loginSubmit.disabled = false;
  }
}

function logout() {
  state.auth = null;
  writeAuthCache(null);
  state.selectedMatId = null;
  closeDrawer();
  showLogin();
  toast("Signed out");
}

function readAuthCache() {
  try {
    const raw = localStorage.getItem(AUTH_CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.token || !data?.user) return null;
    if (data.expiresAt && Date.parse(data.expiresAt) < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function writeAuthCache(auth) {
  try {
    if (!auth) localStorage.removeItem(AUTH_CACHE_KEY);
    else localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(auth));
  } catch {
    /* ignore */
  }
}

function initMap() {
  const cached = readViewCache();
  const startLat = Number.isFinite(cached?.lat) ? cached.lat : 33.5731;
  const startLng = Number.isFinite(cached?.lng) ? cached.lng : -7.5898;
  const startZoom = Number.isFinite(cached?.zoom) ? cached.zoom : DEFAULT_ZOOM;

  state.map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
    maxZoom: MAX_ZOOM,
  }).setView([startLat, startLng], startZoom);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: MAX_ZOOM,
    maxNativeZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(state.map);

  state.layer = L.layerGroup().addTo(state.map);

  if (cached?.matId) {
    state.selectedMatId = String(cached.matId);
  }
  state._didFit = false;

  const persist = () => {
    updateZoomLabel();
    if (!state._restoring) writeViewCache();
  };
  state.map.on("zoomend moveend", persist);
  updateZoomLabel();

  window.addEventListener("resize", () => {
    state.map?.invalidateSize();
  });
}

async function loadSheet(showBusy = false) {
  if (!state.auth?.token) {
    showLogin();
    return;
  }
  if (showBusy) setStatus("Loading Excel…");
  try {
    const payload = await postSheet({ mode: "export" });
    if (!payload.ok) throw new Error(payload.error || payload.hint || "Export failed");
    const mats = parseSheetValues(payload.values || []);
    state.mats = mats;
    state.lastUpdatedAt = payload.updatedAt || new Date().toISOString();
    renderMarkers();

    if (state.selectedMatId) {
      const still = mats.find((m) => String(m.matId) === String(state.selectedMatId));
      if (still) openDrawer(still.matId, { focus: false, persist: false });
      else closeDrawer();
    }

    const withGps = mats.filter((m) => m.latitude != null && m.longitude != null).length;
    setStatus(`${withGps}/${mats.length} · ${formatTime(state.lastUpdatedAt)}`, "ok");
    updateZoomLabel();
  } catch (error) {
    if (/login|session|password|unauthorized/i.test(String(error.message || ""))) {
      logout();
      if (els.loginError) {
        els.loginError.hidden = false;
        els.loginError.textContent = error.message || "Please sign in again";
      }
      return;
    }
    setStatus(error.message || "Sync failed", "err");
    if (showBusy) toast(error.message || "Could not load Excel");
  }
}

async function postSheet(body, options = {}) {
  const withAuth = options.auth !== false;
  const payload = { ...body };
  if (withAuth && state.auth) {
    if (state.auth.user) payload.user = state.auth.user;
    if (state.auth.token) payload.token = state.auth.token;
    if (state.auth.pass) payload.pass = state.auth.pass;
  }

  // Direct Google Apps Script call (runs from user browser, avoids AWS IP blocking and Netlify timeouts)
  const callDirectWebhook = async () => {
    const targetUrl = `${DIRECT_WEBHOOK_URL}?mode=${encodeURIComponent(payload.mode || "export")}`;
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok && data.error) throw new Error(data.error);
    if (!data.ok) throw new Error("Connexion à Google Sheets échouée");
    return data;
  };

  // Try direct webhook first (fastest, direct from user browser, no datacenter block)
  try {
    return await callDirectWebhook();
  } catch (directErr) {
    // If direct failed (e.g. adblocker or strict firewall), try Netlify proxy fallback
    try {
      const response = await fetch(API_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) return data;
      throw new Error(data.error || `Erreur serveur (${response.status})`);
    } catch (proxyErr) {
      throw new Error(directErr.message || proxyErr.message || "Erreur de connexion");
    }
  }
}

function parseSheetValues(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const headers = values[0].map((cell) => String(cell ?? "").trim());
  const latCol = headers.findIndex((h) => /^(latitude|lat)$/i.test(h));
  const lngCol = headers.findIndex((h) => /^(longitude|lng|lon)$/i.test(h));
  const termCol = headers.findIndex((h) => /^terminal$/i.test(h));
  const historyCol = headers.findIndex((h) => /^(history|user)$/i.test(h));

  const mats = [];
  for (let r = 1; r < values.length; r += 1) {
    const row = values[r] || [];
    const matId = String(row[0] ?? "").trim();
    if (!matId) continue;

    const latitude = latCol >= 0 ? parseCoord(row[latCol]) : null;
    const longitude = lngCol >= 0 ? parseCoord(row[lngCol]) : null;
    const terminal = termCol >= 0 ? String(row[termCol] ?? "").trim() : "";
    const history = historyCol >= 0 ? parseHistory(row[historyCol]) : [];

    const aps = [];
    const cameras = [];
    for (let c = 1; c < headers.length - 1; c += 1) {
      if (String(headers[c + 1] || "").toLowerCase() !== "value") continue;
      const header = String(headers[c] || "").trim();
      if (/^(terminal|latitude|longitude|lat|lng|lon|history|user)$/i.test(header)) continue;
      const name = String(row[c] ?? "").trim();
      if (!name) continue;
      const clock = parseClock(row[c + 1]);
      if (/^CAM\d+$/i.test(header)) cameras.push({ name, clock });
      else aps.push({ name, unit: guessUnit(name) || header, clock });
    }

    mats.push({
      matId,
      terminal,
      latitude,
      longitude,
      aps,
      cameras,
      history,
    });
  }
  return mats;
}

function parseHistory(raw) {
  if (raw == null || raw === "") return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return [parsed];
  } catch {
    const str = String(raw).trim();
    if (str) return [{ user: str, detail: `Modifié par ${str}`, action: "edit" }];
  }
  return [];
}

function parseCoord(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  // Empty Excel cells must not become 0,0 (Gulf of Guinea).
  if (n === 0) return null;
  return n;
}

function parseClock(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 12) return null;
  return n;
}

function guessUnit(name) {
  const m = String(name || "").match(/(AP\d+)$/i);
  return m ? m[1].toUpperCase() : "";
}

function renderMarkers() {
  state.layer.clearLayers();
  const bounds = [];

  for (const mat of state.mats) {
    if (mat.latitude == null || mat.longitude == null) continue;
    const latlng = [mat.latitude, mat.longitude];
    bounds.push(latlng);
    const selected = String(state.selectedMatId) === String(mat.matId);
    const devices = buildMatClockDevices(mat);
    const html = matClockMarkerHtml(mat, devices, selected);

    const marker = L.marker(latlng, {
      icon: L.divIcon({
        className: `mat-clock-icon${selected ? " is-selected" : ""}`,
        html,
        iconSize: [96, 110],
        iconAnchor: [48, 48],
      }),
      riseOnHover: true,
      zIndexOffset: selected ? 1200 : 0,
    });
    marker.on("click", (event) => {
      if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
      openDrawer(mat.matId);
    });
    state.layer.addLayer(marker);

    if (selected) {
      L.circle(latlng, {
        radius: 28,
        color: "#3ec7ff",
        weight: 3,
        fillColor: "#3ec7ff",
        fillOpacity: 0.18,
        interactive: false,
      }).addTo(state.layer);
    }
  }

  updateAllMarkerDistances();

  if (bounds.length && !state._didFit) {
    setTimeout(() => {
      fitMap();
      state._didFit = true;
    }, 80);
  }
}

function buildMatClockDevices(mat) {
  const devices = [];
  for (const ap of mat.aps || []) {
    devices.push({
      kind: "ap",
      id: ap.name || ap.unit,
      label: ap.name || ap.unit,
      clock: ap.clock,
      estimated: !Number.isInteger(ap.clock),
    });
  }
  for (const cam of mat.cameras || []) {
    devices.push({
      kind: "camera",
      id: cam.name,
      label: cam.name,
      clock: cam.clock,
      estimated: !Number.isInteger(cam.clock),
    });
  }
  assignClockHours(devices);
  for (const device of devices) {
    device.color = device.kind === "camera"
      ? (device.estimated
        ? { fill: "#7c8da6", stroke: "#c5d0de" }
        : { fill: "#8b5cf6", stroke: "#e9d5ff" })
      : (device.estimated
        ? { fill: "#5b7383", stroke: "#d9ecff" }
        : { fill: "#4ee29b", stroke: "#bbf7d0" });
    device.deg = (device.hour % 12) * 30;
  }
  return devices;
}

function assignClockHours(devices) {
  const used = new Set();
  const pending = [];
  for (const device of devices) {
    if (Number.isInteger(device.clock) && device.clock >= 1 && device.clock <= 12) {
      device.hour = device.clock;
      used.add(device.clock);
    } else {
      pending.push(device);
    }
  }
  const free = [];
  for (let h = 1; h <= 12; h += 1) if (!used.has(h)) free.push(h);
  free.sort((a, b) => hashSeed(String(a)) - hashSeed(String(b)));
  pending.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  pending.forEach((device, index) => {
    if (free.length) device.hour = free.shift();
    else {
      device.hour = (hashSeed(String(device.id)) % 12) + 1;
      device.ring = 1 + (index % 2);
    }
    device.estimated = true;
  });
  const byHour = new Map();
  for (const device of devices) {
    const list = byHour.get(device.hour) || [];
    list.push(device);
    byHour.set(device.hour, list);
  }
  for (const list of byHour.values()) {
    if (list.length < 2) continue;
    list.forEach((device, i) => {
      device.ring = i;
      device.degJitter = (i - (list.length - 1) / 2) * 8;
    });
  }
}

function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function getBeachRotation() {
  if (state.horlogeMode !== "adapted") return 0;
  // On the static geographic Leaflet map (North-up), 12h points towards the beach (e.g. 330° NW)
  return state.beachBearing;
}

function getHandheldDialRotation() {
  if (state.horlogeMode !== "adapted") return 0;
  if (state.compass.watching && Number.isFinite(state.compass.heading)) {
    return ((state.beachBearing - state.compass.heading) % 360 + 360) % 360;
  }
  return 0; // When compass is off, 12h stays straight ahead (top of phone)
}

function matClockMarkerHtml(mat, devices, selected = false) {
  const hub = `${mat.aps.length}·${mat.cameras.length}`;
  const isAdapted = state.horlogeMode === "adapted";
  const rot = getBeachRotation();
  const nodes = devices
    .map((device) => {
      const deg = (device.deg || 0) + (device.degJitter || 0);
      const ring = device.ring || 0;
      const title = `${device.label} · clock ${device.hour}${device.estimated ? " (est.)" : ""}`;
      return `<span class="mat-clock-node ${device.kind} ${device.estimated ? "estimated" : ""}" style="--deg:${deg}deg;--ring:${ring};--fill:${device.color.fill};--stroke:${device.color.stroke}" title="${escapeHtml(title)}"></span>`;
    })
    .join("");
  const ticks = [12, 3, 6, 9]
    .map((h) => `<i class="mat-clock-tick" style="--deg:${(h % 12) * 30}deg">${h === 12 ? "12" : h}</i>`)
    .join("");
  let distStr = "";
  if (state.gps.watching && state.gps.lat != null && state.gps.lng != null && mat.latitude != null && mat.longitude != null) {
    const d = getDistanceMeters(state.gps.lat, state.gps.lng, mat.latitude, mat.longitude);
    mat._distanceMeters = d;
    distStr = formatDistance(d);
  }

  const termBadge = mat.terminal ? `<span class="mat-caption-term">${escapeHtml(mat.terminal)}</span>` : "";

  return `<div class="mat-clock-marker${selected ? " is-selected" : ""}" title="${mat.terminal ? `[${escapeHtml(mat.terminal)}] ` : ""}MAT ${escapeHtml(mat.matId)}">
    <div class="mat-clock-ring ${isAdapted ? "is-adapted" : ""}" style="--ring-rot:${rot}deg">
      <span class="mat-clock-beach" title="Beach · 12">B</span>
      ${ticks}
      ${nodes}
      <div class="mat-clock-hub" title="APs · Cameras">${escapeHtml(hub)}</div>
    </div>
    <div class="mat-clock-caption">
      <span class="mat-clock-caption-id">${termBadge}MAT ${escapeHtml(mat.matId)}</span>
      <span class="mat-clock-dist" data-mat-dist="${escapeHtml(mat.matId)}" ${distStr ? "" : "hidden"}>${distStr ? `📍 ${distStr}` : ""}</span>
    </div>
  </div>`;
}

function fitMap() {
  if (!state.map) return;
  state.map.invalidateSize();
  const bounds = state.mats
    .filter((m) => m.latitude != null && m.longitude != null)
    .map((m) => [m.latitude, m.longitude]);
  if (!bounds.length) return;
  fitBounds(bounds);
}

function fitBounds(bounds) {
  if (!bounds.length || !state.map) return;
  state.map.invalidateSize();
  if (bounds.length === 1) {
    state.map.setView(bounds[0], DEFAULT_ZOOM, { animate: true });
    writeViewCache();
    updateZoomLabel();
    return;
  }
  const isMobile = window.innerWidth <= 768;
  const padding = isMobile ? [18, 18] : [36, 36];
  state.map.fitBounds(bounds, { padding, maxZoom: 17, animate: true });
  writeViewCache();
  updateZoomLabel();
}

function openDrawer(matId, options = {}) {
  const focus = options.focus !== false;
  const persist = options.persist !== false;
  const mat = state.mats.find((item) => String(item.matId) === String(matId));
  if (!mat) return;
  state.selectedMatId = mat.matId;
  document.getElementById("app")?.classList.add("has-drawer");
  renderMarkers();
  setTimeout(() => {
    state.map?.invalidateSize();
  }, 180);
  if (focus && mat.latitude != null && mat.longitude != null) {
    const zoom = Math.max(state.map.getZoom(), DEFAULT_ZOOM);
    state.map.setView([mat.latitude, mat.longitude], zoom, { animate: true });
  }
  renderDrawer(mat);
  els.drawer.hidden = false;
  if (persist) writeViewCache();
  updateDistanceLine();
  updateDrawerDistance();
}

function closeDrawer() {
  state.selectedMatId = null;
  document.getElementById("app")?.classList.remove("has-drawer");
  els.drawer.hidden = true;
  updateDistanceLine();
  renderMarkers();
  writeViewCache();
  setTimeout(() => {
    state.map?.invalidateSize();
  }, 180);
}

function readViewCache() {
  try {
    const raw = localStorage.getItem(VIEW_CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return {
      lat: Number(data.lat),
      lng: Number(data.lng),
      zoom: Number(data.zoom),
      matId: data.matId != null && data.matId !== "" ? String(data.matId) : null,
    };
  } catch {
    return null;
  }
}

function writeViewCache() {
  if (!state.map) return;
  try {
    const center = state.map.getCenter();
    localStorage.setItem(
      VIEW_CACHE_KEY,
      JSON.stringify({
        lat: center.lat,
        lng: center.lng,
        zoom: state.map.getZoom(),
        matId: state.selectedMatId,
        at: Date.now(),
      }),
    );
  } catch {
    /* ignore quota / private mode */
  }
}

function updateZoomLabel() {
  if (!els.zoomLevel || !state.map) return;
  els.zoomLevel.textContent = `z${state.map.getZoom()}`;
}

function panMap(direction) {
  if (!state.map || !window.L) return;
  const size = state.map.getSize();
  const stepX = Math.max(120, Math.round(size.x * 0.4));
  const stepY = Math.max(120, Math.round(size.y * 0.4));
  const moves = {
    left: [-stepX, 0],
    right: [stepX, 0],
    up: [0, -stepY],
    down: [0, stepY],
  };
  const delta = moves[direction];
  if (!delta) return;
  state.map.panBy(delta, { animate: true, duration: 0.25 });
}

function renderDrawer(mat) {
  const termBadge = mat.terminal ? ` <span class="drawer-term-badge">${escapeHtml(mat.terminal)}</span>` : "";
  els.drawerTitle.innerHTML = `MAT ${escapeHtml(mat.matId)}${termBadge}`;
  if (els.drawerMeta) {
    const bits = [];
    if (mat.terminal) bits.push(mat.terminal);
    if (mat.latitude == null || mat.longitude == null) bits.push("⚠️ Non cartographié");
    if (mat.aps.length) bits.push(`${mat.aps.length} AP`);
    if (mat.cameras.length) bits.push(`${mat.cameras.length} cam`);
    const last = (mat.history || [])[mat.history.length - 1];
    if (last?.user) bits.push(`last: ${last.user}`);
    els.drawerMeta.textContent = bits.join(" · ");
    els.drawerMeta.hidden = bits.length === 0;
  }
  updateDrawerDistance();
  if (els.drawerModeBtn) {
    els.drawerModeBtn.textContent = state.horlogeMode === "adapted" ? "🏖️ Adapté" : "⏱️ Normal";
    els.drawerModeBtn.title = state.horlogeMode === "adapted"
      ? "Mode Adapté actif : 12h pointe vers la plage physique. Cliquer pour passer en Mode Normal."
      : "Mode Normal actif : cadran fixe. Cliquer pour activer la boussole adaptée à la plage.";
  }
  if (els.drawerBeachBtn) {
    els.drawerBeachBtn.textContent = `🎯 ${state.beachBearing}°`;
    els.drawerBeachBtn.title = `Réf. Plage : ${getBearingCompassText(state.beachBearing)}. Cliquer pour calibrer / ajuster.`;
  }

  const isAdapted = state.horlogeMode === "adapted";
  const estimated = isAdapted ? state.compass.estimatedClock : null;
  const cards = [];

  for (const ap of mat.aps) {
    const key = ap.unit || ap.name;
    cards.push(`<div class="ori-clock-wrap" data-device-card="${escapeHtml(key)}">
      <span class="ori-kind">AP</span>
      ${renderClockCard("ap", key, ap.name || key, ap.clock, estimated, mat.matId)}
    </div>`);
  }
  for (const cam of mat.cameras) {
    cards.push(`<div class="ori-clock-wrap" data-device-card="${escapeHtml(cam.name)}">
      <span class="ori-kind cam">CAM</span>
      ${renderClockCard("camera", cam.name, "Camera", cam.clock, estimated, mat.matId)}
    </div>`);
  }
  cards.push(renderHistoryBlock(mat.history || []));
  els.drawerBody.innerHTML = cards.length
    ? cards.join("")
    : `<div class="sync-status">Aucun AP ou caméra sur cette ligne MAT</div>`;

  els.drawerBody.querySelectorAll("[data-clock-hour]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const hour = Number(button.dataset.clockHour);
      const already = button.classList.contains("active");
      void saveOrientation({
        matId: button.dataset.matId,
        kind: button.dataset.kind,
        key: button.dataset.key,
        clock: already ? null : hour,
      });
    });
  });
  els.drawerBody.querySelectorAll("[data-apply-estimate]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (state.compass.estimatedClock == null) return;
      void saveOrientation({
        matId: button.dataset.matId,
        kind: button.dataset.kind,
        key: button.dataset.key,
        clock: state.compass.estimatedClock,
      });
    });
  });
  els.drawerBody.querySelectorAll("[data-clear-device]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      void saveOrientation({
        matId: button.dataset.matId,
        kind: button.dataset.kind,
        key: button.dataset.key,
        clock: null,
      });
    });
  });
}

function renderHistoryBlock(history) {
  const items = [...(history || [])].slice(-15).reverse();
  if (!items.length) {
    return `<div class="history-block"><div class="history-title">Historique</div><p class="history-empty">Aucune modification</p></div>`;
  }
  const rows = items.map((entry) => {
    const text = entry.detail ? escapeHtml(entry.detail) : formatHistoryEntry(entry);
    return `<li>${text}</li>`;
  }).join("");
  return `<div class="history-block"><div class="history-title">Historique</div><ul class="history-list">${rows}</ul></div>`;
}

function formatHistoryEntry(entry) {
  const user = entry.user ? `<strong>${escapeHtml(entry.user)}</strong>: ` : "";
  const kind = String(entry.kind || "").toUpperCase() || "DEV";
  const key = entry.key || "?";
  const when = entry.at ? formatTime(entry.at) : "";
  if (entry.action === "clear") {
    return `${user}effacé ${kind} ${key}${entry.from != null ? ` (était ${entry.from})` : ""}${when ? ` · ${when}` : ""}`;
  }
  if (entry.action === "change") {
    return `${user}modifié ${kind} ${key} ${entry.from ?? "—"} → ${entry.to}${when ? ` · ${when}` : ""}`;
  }
  return `${user}défini ${kind} ${key} → ${entry.to}${when ? ` · ${when}` : ""}`;
}

function renderClockCard(kind, key, subtitle, clock, estimated, matId) {
  const hours = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const pendingKey = `${matId}:${kind}:${key}`;
  const pending = Boolean(state.pending[pendingKey]);
  const isAdapted = state.horlogeMode === "adapted";
  const dialRot = getHandheldDialRotation();

  return `
    <article class="clock-card ${pending ? "is-pending" : ""}" data-kind="${escapeHtml(kind)}" data-key="${escapeHtml(key)}" data-mat-id="${escapeHtml(matId)}">
      <div class="clock-card-head">
        <div>
          <strong>${escapeHtml(key)}</strong>
          <small>${escapeHtml(subtitle || "")}</small>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          ${clock != null ? `<button type="button" class="ghost clock-clear-btn" style="font-size:10px;padding:2px 6px;color:#ff6b6b;" data-clear-device data-kind="${escapeHtml(kind)}" data-key="${escapeHtml(key)}" data-mat-id="${escapeHtml(matId)}" ${pending ? "disabled" : ""}>Clear</button>` : ""}
          <div class="clock-value">${clock != null ? `${clock}h` : "—"}</div>
        </div>
      </div>
      <div class="clock-face ${isAdapted ? "is-adapted" : ""}" style="--dial-rot:${dialRot}deg" aria-label="Cadran pour ${escapeHtml(key)}">
        <span class="clock-beach">Beach · 12</span>
        ${hours.map((hour) => {
          const angle = (hour % 12) * 30;
          return `<button type="button" class="clock-hour ${clock === hour ? "active" : ""} ${estimated === hour ? "suggest" : ""}"
            style="--deg:${angle}deg"
            data-kind="${escapeHtml(kind)}"
            data-key="${escapeHtml(key)}"
            data-mat-id="${escapeHtml(matId)}"
            data-clock-hour="${hour}"
            ${pending ? "disabled" : ""}>${hour}</button>`;
        }).join("")}
        <span class="clock-center"></span>
        ${clock != null ? `<div class="clock-pointer" style="--ptr-deg:${(clock % 12) * 30}deg"></div>` : ""}
      </div>
      <div class="clock-save-status" ${pending ? "" : "hidden"}>${pending ? "Enregistrement…" : ""}</div>
      ${estimated != null
        ? `<button type="button" class="secondary-button clock-apply" data-apply-estimate data-kind="${escapeHtml(kind)}" data-key="${escapeHtml(key)}" data-mat-id="${escapeHtml(matId)}" ${pending ? "disabled" : ""}>🎯 Viseur boussole → ${estimated}h</button>`
        : ""}
    </article>`;
}

async function saveOrientation({ matId, kind, key, clock }) {
  const pendingKey = `${matId}:${kind}:${key}`;
  state.pending[pendingKey] = true;
  const mat = state.mats.find((item) => String(item.matId) === String(matId));
  if (mat) {
    const list = kind === "ap" ? mat.aps : mat.cameras;
    const item = list.find((row) => (row.unit || row.name) === key || row.name === key);
    if (item) item.clock = clock;
    renderMarkers();
    renderDrawer(mat);
  }

  const patch = { matId, aps: {}, cameras: {} };
  if (kind === "ap") patch.aps[key] = clock;
  else patch.cameras[key] = clock;

  try {
    const payload = await postSheet({ mode: "patch", patch });
    if (!payload.ok) throw new Error(payload.error || "Patch failed");
    if (mat && Array.isArray(payload.history)) {
      mat.history = payload.history;
      if (String(state.selectedMatId) === String(matId)) renderDrawer(mat);
    }
    toast(clock == null ? `${key} effacé` : `${key} → ${clock}h`);
    setStatus(`Enregistré · ${formatTime(new Date().toISOString())}`, "ok");
  } catch (error) {
    if (/login|session|password|unauthorized/i.test(String(error.message || ""))) {
      logout();
      return;
    }
    toast(error.message || "Échec de sauvegarde");
    setStatus(error.message || "Échec de sauvegarde", "err");
    await loadSheet(false);
  } finally {
    delete state.pending[pendingKey];
    const again = state.mats.find((item) => String(item.matId) === String(matId));
    if (again && String(state.selectedMatId) === String(matId)) renderDrawer(again);
  }
}

/* -------------------------------------------------------------
   SEARCH & FILTER
------------------------------------------------------------- */
function handleSearchInput(event) {
  const query = String(event.target.value || "").trim().toLowerCase();
  state.searchQuery = query;
  if (els.searchClear) els.searchClear.hidden = !query;
  if (!query) {
    closeSearchDropdown();
    return;
  }
  const results = [];
  const queryNormalized = query.replace(/^mat\s*/i, "").trim();

  for (const mat of state.mats) {
    const matIdStr = String(mat.matId).toLowerCase();
    const termStr = String(mat.terminal || "").toLowerCase();
    const fullMat1 = `${termStr ? `${termStr}-` : ""}mat${matIdStr}`;
    const fullMat2 = `${termStr ? `${termStr} ` : ""}mat ${matIdStr}`;
    const fullMat3 = `${termStr ? `${termStr}` : ""}${matIdStr}`;
    let matched = false;
    let matchKind = "mat";
    let matchDetail = "";

    // 1. Terminal search (e.g. typing "tc3" or "tce")
    if (termStr && (query === termStr || query === "tc3" && termStr === "tc3" || query === "tce" && termStr === "tce")) {
      matched = true;
      matchKind = "mat";
      matchDetail = `Terminal ${mat.terminal}`;
    }

    // 2. Direct MAT ID match (e.g. "1", "mat 1", "tc3-mat1", "tce-mat49")
    if (!matched) {
      if (
        matIdStr === queryNormalized ||
        matIdStr === query ||
        matIdStr.includes(queryNormalized) ||
        fullMat1.includes(query) ||
        fullMat2.includes(query) ||
        fullMat3 === query
      ) {
        matched = true;
        matchKind = "mat";
      }
    }

    // 3. AP Name match (e.g. "tc3-mat1-ap1", "ap1", "tce-mat49-ap1")
    if (!matched) {
      for (const ap of mat.aps) {
        const apName = String(ap.name || "").toLowerCase();
        const apUnit = String(ap.unit || "").toLowerCase();
        if (
          apName.includes(query) ||
          apUnit.includes(query) ||
          (queryNormalized && apName.includes(queryNormalized))
        ) {
          matched = true;
          matchKind = "ap";
          matchDetail = ap.name || ap.unit;
          break;
        }
      }
    }

    // 4. Camera Name match (e.g. "mtc27", "dtc128", "cam1")
    if (!matched) {
      for (const cam of mat.cameras) {
        const camName = String(cam.name || "").toLowerCase();
        if (
          camName.includes(query) ||
          (queryNormalized && camName.includes(queryNormalized))
        ) {
          matched = true;
          matchKind = "cam";
          matchDetail = cam.name;
          break;
        }
      }
    }

    if (matched) {
      let dist = null;
      if (state.gps.lat != null && mat.latitude != null && mat.longitude != null) {
        dist = getDistanceMeters(state.gps.lat, state.gps.lng, mat.latitude, mat.longitude);
      }
      results.push({ mat, matchKind, matchDetail, dist });
    }
  }

  // Sorting:
  // - exact match first
  // - then items with distance (closest first)
  // - then items without distance
  // - alphanumeric order
  results.sort((a, b) => {
    const aExact = String(a.mat.matId) === queryNormalized || String(a.matchDetail).toLowerCase() === query;
    const bExact = String(b.mat.matId) === queryNormalized || String(b.matchDetail).toLowerCase() === query;
    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;
    if (a.dist != null && b.dist != null) return a.dist - b.dist;
    if (a.dist != null && b.dist == null) return -1;
    if (a.dist == null && b.dist != null) return 1;
    return String(a.mat.matId).localeCompare(String(b.mat.matId), undefined, { numeric: true });
  });

  state.searchResults = results.slice(0, 30);
  state.searchSelectedIndex = -1;
  renderSearchDropdown();
}

function handleSearchKeydown(event) {
  if (!state.searchResults.length || els.searchDropdown?.hidden) return;

  if (event.key === "ArrowDown") {
    event.preventDefault();
    state.searchSelectedIndex = Math.min(state.searchSelectedIndex + 1, state.searchResults.length - 1);
    updateSearchHighlight();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    state.searchSelectedIndex = Math.max(state.searchSelectedIndex - 1, 0);
    updateSearchHighlight();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const idx = state.searchSelectedIndex >= 0 ? state.searchSelectedIndex : 0;
    const item = state.searchResults[idx];
    if (item) {
      selectSearchResult(item.mat.matId, item.matchDetail);
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeSearchDropdown();
  }
}

function updateSearchHighlight() {
  if (!els.searchDropdown) return;
  const items = els.searchDropdown.querySelectorAll(".search-item");
  items.forEach((el, idx) => {
    el.classList.toggle("is-selected", idx === state.searchSelectedIndex);
    if (idx === state.searchSelectedIndex) {
      el.scrollIntoView({ block: "nearest" });
    }
  });
}

function renderSearchDropdown() {
  if (!els.searchDropdown) return;
  if (!state.searchResults.length) {
    els.searchDropdown.innerHTML = `<div class="search-empty">Aucun équipement trouvé pour "${escapeHtml(state.searchQuery)}"</div>`;
    els.searchDropdown.hidden = false;
    return;
  }

  const html = state.searchResults.map((item, idx) => {
    const { mat, matchKind, matchDetail, dist } = item;
    let badgeClass = "badge-mat";
    let badgeText = "MAT";
    let title = `MAT ${mat.matId}`;
    let sub = `${mat.aps.length} AP · ${mat.cameras.length} Cam`;

    if (matchKind === "ap") {
      badgeClass = "badge-ap";
      badgeText = "AP";
      title = `${matchDetail} (MAT ${mat.matId})`;
    } else if (matchKind === "cam") {
      badgeClass = "badge-cam";
      badgeText = "CAM";
      title = `${matchDetail} (MAT ${mat.matId})`;
    }

    const termTag = mat.terminal
      ? `<span class="search-term-tag ${mat.terminal.toLowerCase()}">${escapeHtml(mat.terminal)}</span>`
      : "";
    const distTag = dist != null
      ? `<span class="search-dist-tag">📍 ${formatDistance(dist)}</span>`
      : (mat.latitude == null || mat.longitude == null ? `<span class="search-unmapped-tag">Non-carto</span>` : "");

    return `<div class="search-item ${idx === state.searchSelectedIndex ? "is-selected" : ""}" data-index="${idx}" data-mat-id="${mat.matId}" data-target-name="${escapeHtml(matchDetail)}">
      <div class="search-item-left">
        <span class="search-badge ${badgeClass}">${badgeText}</span>
        ${termTag}
        <span class="search-item-title">${escapeHtml(title)}</span>
      </div>
      <div class="search-item-right">
        ${distTag}
        <span>${sub}</span>
      </div>
    </div>`;
  }).join("");

  els.searchDropdown.innerHTML = html;
  els.searchDropdown.hidden = false;

  els.searchDropdown.querySelectorAll(".search-item").forEach((el) => {
    el.addEventListener("click", () => {
      const matId = el.dataset.matId;
      const targetName = el.dataset.targetName;
      selectSearchResult(matId, targetName);
    });
  });
}

function selectSearchResult(matId, targetName = "") {
  closeSearchDropdown();
  const mat = state.mats.find((m) => String(m.matId) === String(matId));
  if (!mat) return;

  openDrawer(mat.matId, { focus: true });

  if (mat.latitude == null || mat.longitude == null) {
    toast(`MAT ${mat.matId}${mat.terminal ? ` (${mat.terminal})` : ""} ouvert (non cartographié)`);
  }

  if (targetName) {
    setTimeout(() => {
      const wraps = document.querySelectorAll(".ori-clock-wrap");
      for (const wrap of wraps) {
        if (wrap.dataset.deviceCard === targetName || wrap.textContent.includes(targetName)) {
          wrap.scrollIntoView({ behavior: "smooth", block: "center" });
          wrap.classList.add("is-highlight-target");
          setTimeout(() => wrap.classList.remove("is-highlight-target"), 2500);
          break;
        }
      }
    }, 250);
  }
}

function closeSearchDropdown() {
  if (els.searchDropdown) els.searchDropdown.hidden = true;
  state.searchSelectedIndex = -1;
}

function clearSearch() {
  if (els.searchInput) els.searchInput.value = "";
  state.searchQuery = "";
  if (els.searchClear) els.searchClear.hidden = true;
  closeSearchDropdown();
}

/* -------------------------------------------------------------
   GPS TRACKING & DISTANCES
------------------------------------------------------------- */
function toggleGps() {
  if (state.gps.watching) {
    stopGps();
    toast("GPS arrêté");
  } else {
    startGps(true);
  }
}

function startGps(centerMap = true) {
  if (!navigator.geolocation) {
    toast("GPS non disponible sur cet appareil");
    return;
  }
  state.gps.watching = true;
  updateGpsUi();
  toast("Recherche signal GPS haute précision…");

  let firstFix = true;
  state.gps.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy, heading } = pos.coords;
      state.gps.lat = latitude;
      state.gps.lng = longitude;
      state.gps.accuracy = accuracy;
      if (Number.isFinite(heading)) state.gps.heading = heading;
      state.gps.error = null;

      updateGpsMarker(latitude, longitude, accuracy, state.gps.heading || state.compass.heading);
      updateGpsUi();

      if (firstFix && centerMap && state.map) {
        firstFix = false;
        state.map.setView([latitude, longitude], Math.max(state.map.getZoom(), 19), { animate: true });
        toast(`GPS connecté (±${Math.round(accuracy)}m)`);
      }

      // Real-time distance update across map markers, drawer, line and search
      updateAllMarkerDistances();
      if (state.selectedMatId) {
        updateDrawerDistance();
      }
      if (state.searchQuery && !els.searchDropdown?.hidden) {
        handleSearchInput({ target: els.searchInput });
      }
    },
    (err) => {
      state.gps.error = err.message;
      if (err.code === 1) {
        toast("Autorisation GPS refusée");
      } else {
        toast("Signal GPS faible ou indisponible");
      }
      updateGpsUi();
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
}

function stopGps() {
  if (state.gps.watchId != null) {
    navigator.geolocation.clearWatch(state.gps.watchId);
    state.gps.watchId = null;
  }
  state.gps.watching = false;
  state.gps.lat = null;
  state.gps.lng = null;
  state.gps.accuracy = null;
  if (state.gps.marker && state.map) {
    state.map.removeLayer(state.gps.marker);
    state.gps.marker = null;
  }
  if (state.gps.circle && state.map) {
    state.map.removeLayer(state.gps.circle);
    state.gps.circle = null;
  }
  if (state.gps.distanceLine && state.map) {
    state.map.removeLayer(state.gps.distanceLine);
    state.gps.distanceLine = null;
  }
  updateGpsUi();
  updateAllMarkerDistances();
  if (state.selectedMatId) updateDrawerDistance();
}

function updateGpsMarker(lat, lng, accuracy, heading) {
  if (!state.map) return;
  const latlng = [lat, lng];

  if (!state.gps.marker) {
    const icon = L.divIcon({
      className: "user-gps-marker",
      html: `<div class="user-gps-pulse"></div><div class="user-gps-dot"><div class="user-gps-cone" id="user-gps-cone"></div></div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
    state.gps.marker = L.marker(latlng, { icon, zIndexOffset: 2500 }).addTo(state.map);
    state.gps.circle = L.circle(latlng, {
      radius: accuracy || 8,
      color: "#38bdf8",
      weight: 1.5,
      fillColor: "#38bdf8",
      fillOpacity: 0.12,
      interactive: false,
    }).addTo(state.map);
  } else {
    state.gps.marker.setLatLng(latlng);
    state.gps.circle.setLatLng(latlng);
    state.gps.circle.setRadius(accuracy || 8);
  }

  const cone = document.getElementById("user-gps-cone");
  if (cone) {
    if (Number.isFinite(heading)) {
      cone.style.display = "block";
      cone.style.transform = `translateX(-50%) rotate(${heading}deg)`;
    } else {
      cone.style.display = "none";
    }
  }
}

function updateGpsUi() {
  if (!els.btnGpsToggle) return;
  if (state.gps.watching) {
    els.btnGpsToggle.classList.add("is-active");
    const accStr = state.gps.accuracy ? ` ±${Math.round(state.gps.accuracy)}m` : "";
    els.btnGpsToggle.textContent = `📍 GPS${accStr}`;
    els.btnGpsToggle.classList.toggle("is-pulsing", state.gps.accuracy != null);
  } else {
    els.btnGpsToggle.classList.remove("is-active", "is-pulsing");
    els.btnGpsToggle.textContent = "📍 GPS";
  }
}

function updateDrawerDistance() {
  if (!els.drawerDistance) return;
  const mat = state.mats.find((m) => String(m.matId) === String(state.selectedMatId));
  if (mat && state.gps.lat != null && mat.latitude != null && mat.longitude != null) {
    const d = getDistanceMeters(state.gps.lat, state.gps.lng, mat.latitude, mat.longitude);
    els.drawerDistance.textContent = `📍 ${formatDistance(d)}`;
    els.drawerDistance.hidden = false;
  } else {
    els.drawerDistance.hidden = true;
  }
}

function updateAllMarkerDistances() {
  const hasGps = state.gps.watching && state.gps.lat != null && state.gps.lng != null;
  let closestMat = null;
  let minDistance = Infinity;

  for (const mat of state.mats) {
    if (mat.latitude == null || mat.longitude == null) continue;
    if (hasGps) {
      const d = getDistanceMeters(state.gps.lat, state.gps.lng, mat.latitude, mat.longitude);
      mat._distanceMeters = d;
      if (d != null && d < minDistance) {
        minDistance = d;
        closestMat = mat;
      }
    } else {
      mat._distanceMeters = null;
    }
  }

  document.querySelectorAll("[data-mat-dist]").forEach((el) => {
    const matId = el.dataset.matDist;
    const mat = state.mats.find((m) => String(m.matId) === String(matId));
    if (hasGps && mat && Number.isFinite(mat._distanceMeters)) {
      el.hidden = false;
      const isClosest = closestMat && String(closestMat.matId) === String(mat.matId);
      el.textContent = `📍 ${formatDistance(mat._distanceMeters)}`;
      el.classList.toggle("is-closest", Boolean(isClosest));
    } else {
      el.hidden = true;
      el.textContent = "";
      el.classList.remove("is-closest");
    }
  });

  updateClosestMatPill(closestMat, minDistance);
  updateDistanceLine();
}

function updateClosestMatPill(closestMat, minDistance) {
  if (!els.closestMatPill) return;
  if (!closestMat || !Number.isFinite(minDistance) || !state.gps.watching) {
    els.closestMatPill.hidden = true;
    state.closestMatId = null;
    return;
  }
  state.closestMatId = closestMat.matId;
  if (els.closestMatName) els.closestMatName.textContent = `MAT ${closestMat.matId}`;
  if (els.closestMatDist) els.closestMatDist.textContent = `📍 ${formatDistance(minDistance)}`;
  els.closestMatPill.hidden = false;
}

function updateDistanceLine() {
  if (!state.map) return;
  const hasGps = state.gps.watching && state.gps.lat != null && state.gps.lng != null;
  if (!hasGps || !state.selectedMatId) {
    if (state.gps.distanceLine) {
      state.map.removeLayer(state.gps.distanceLine);
      state.gps.distanceLine = null;
    }
    return;
  }
  const mat = state.mats.find((m) => String(m.matId) === String(state.selectedMatId));
  if (!mat || mat.latitude == null || mat.longitude == null) {
    if (state.gps.distanceLine) {
      state.map.removeLayer(state.gps.distanceLine);
      state.gps.distanceLine = null;
    }
    return;
  }

  const from = [state.gps.lat, state.gps.lng];
  const to = [mat.latitude, mat.longitude];
  const d = getDistanceMeters(state.gps.lat, state.gps.lng, mat.latitude, mat.longitude);
  const tooltipText = `📍 ${formatDistance(d)}`;

  if (!state.gps.distanceLine) {
    state.gps.distanceLine = L.polyline([from, to], {
      color: "#38bdf8",
      weight: 3,
      dashArray: "6, 8",
      opacity: 0.9,
      interactive: false,
    }).addTo(state.map);

    state.gps.distanceLine.bindTooltip(tooltipText, {
      permanent: true,
      direction: "center",
      className: "distance-line-tooltip",
    });
  } else {
    state.gps.distanceLine.setLatLngs([from, to]);
    state.gps.distanceLine.setTooltipContent(tooltipText);
  }
}

function getDistanceMeters(lat1, lon1, lat2, lon2) {
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) return null;
  const R = 6371e3; // metres
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "";
  if (meters < 1000) return `${meters}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

/* -------------------------------------------------------------
   BEACH CALIBRATION & PERSISTENCE (Beach = 12h)
------------------------------------------------------------- */
function updateBeachDisplay() {
  const text = getBearingCompassText(state.beachBearing);
  if (els.horlogeBeachValue) {
    els.horlogeBeachValue.textContent = text;
  }
  if (els.btnBearingCustom) {
    els.btnBearingCustom.textContent = text;
  }
  if (els.drawerBeachBtn) {
    els.drawerBeachBtn.textContent = `🎯 ${state.beachBearing}°`;
    els.drawerBeachBtn.title = `Réf. Plage : ${text}. Cliquer pour ajuster.`;
  }
  document.querySelectorAll(".horloge-calibrate-section .preset-chip").forEach((chip) => {
    const b = Number(chip.dataset.bearing);
    chip.classList.toggle("is-selected", b === state.beachBearing);
  });
}

function setBeachBearing(bearingDeg, notify = true) {
  const normalized = ((Math.round(Number(bearingDeg) || 0) % 360) + 360) % 360;
  state.beachBearing = normalized;
  try {
    localStorage.setItem(BEACH_BEARING_CACHE_KEY, String(normalized));
  } catch {}

  updateBeachDisplay();

  // Re-render map markers so clock rings immediately adopt new beach orientation
  renderMarkers();

  // If drawer is open, update drawer AP and Camera dials
  if (state.selectedMatId) {
    const mat = state.mats.find((m) => String(m.matId) === String(state.selectedMatId));
    if (mat) renderDrawer(mat);
  }

  // Update floating dial
  if (state.compass.watching && Number.isFinite(state.compass.heading)) {
    updateHorlogeDial(state.compass.heading);
  } else {
    updateHorlogeDial(null);
  }

  if (notify) {
    toast(`🎯 Plage (12h) définie sur ${getBearingCompassText(normalized)}`);
  }
}

async function calibrateBeachToCurrentHeading() {
  if (!state.compass.watching) {
    await startCompass();
  }
  if (!Number.isFinite(state.compass.heading)) {
    promptCustomBearing();
    return;
  }
  const heading = Math.round(state.compass.heading);
  setBeachBearing(heading, false);
  toast(`🎯 Plage (12h) calibrée sur votre visée : ${getBearingCompassText(heading)}`);
}

function promptCustomBearing() {
  const current = state.beachBearing;
  const input = window.prompt(
    `Entrez l'orientation de la plage en degrés (0°-359°) :\nEx: 330 (Port Casablanca / Mer), 0 (Nord), 58 (Est)`,
    String(current)
  );
  if (input !== null && input.trim() !== "") {
    const num = Number(input);
    if (Number.isFinite(num)) {
      setBeachBearing(num, true);
    } else {
      toast("Angle invalide (doit être entre 0° et 359°)");
    }
  }
}

function handleDrawerBeachClick() {
  toggleHorlogeWidget(true);
  toast(`🎯 Réf. Plage : ${getBearingCompassText(state.beachBearing)}. Utilisez les boutons pour calibrer.`);
}

/* -------------------------------------------------------------
   ADAPTIVE BEACH COMPASS & HORLOGE (Beach = 12h)
------------------------------------------------------------- */
function setHorlogeMode(mode) {
  state.horlogeMode = mode;
  const isAdapted = mode === "adapted";
  els.btnModeAdapted?.classList.toggle("is-active", isAdapted);
  els.btnModeNormal?.classList.toggle("is-active", !isAdapted);
  if (els.drawerModeBtn) {
    els.drawerModeBtn.textContent = isAdapted ? "🏖️ Adapté" : "⏱️ Normal";
  }
  if (els.horlogeFooterHint) {
    els.horlogeFooterHint.textContent = isAdapted
      ? `Mode Adapté : AP et Caméras orientés selon la plage (${getBearingCompassText(state.beachBearing)} = 12h).`
      : "Mode Normal : cadran fixe. Placez-vous face à la plage physique pour régler l'orientation.";
  }

  // Re-render map markers so clock rings immediately adopt the beach orientation
  renderMarkers();

  if (isAdapted) {
    if (!state.compass.watching) void startCompass();
    updateHorlogeDial(state.compass.heading != null ? state.compass.heading : null);
  } else {
    // Reset dials to static 0 rotation (12 at top)
    if (els.horlogeRotatingDial) {
      els.horlogeRotatingDial.style.transform = "none";
    }
    if (els.horlogeAimValue) {
      els.horlogeAimValue.textContent = "12h (Plage en face)";
    }
    document.querySelectorAll(".clock-face").forEach((face) => {
      face.classList.remove("is-adapted");
      face.style.setProperty("--dial-rot", "0deg");
    });
    document.querySelectorAll(".mat-clock-ring").forEach((ring) => {
      ring.classList.remove("is-adapted");
      ring.style.setProperty("--ring-rot", "0deg");
    });
  }

  // Refresh drawer cards if open to update AP and camera dials
  if (state.selectedMatId) {
    const mat = state.mats.find((m) => String(m.matId) === String(state.selectedMatId));
    if (mat) renderDrawer(mat);
  }

  toast(isAdapted ? `🏖️ Mode Adapté : Plage = ${getBearingCompassText(state.beachBearing)} (12h)` : "⏱️ Mode Normal : cadran fixe");
}

function toggleHorlogeMode() {
  setHorlogeMode(state.horlogeMode === "adapted" ? "normal" : "adapted");
}

function toggleHorlogeWidget(forceOpen) {
  const next = typeof forceOpen === "boolean" ? forceOpen : !state.horlogeOpen;
  state.horlogeOpen = next;
  if (els.floatingHorloge) els.floatingHorloge.hidden = !next;
  if (els.btnHorlogeToggle) els.btnHorlogeToggle.classList.toggle("is-active", next);
  if (next) {
    updateBeachDisplay();
    if (state.horlogeMode === "adapted" && !state.compass.watching) {
      void startCompass();
    }
  }
}

async function startCompass() {
  state.compass.error = null;
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    try {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") {
        state.compass.error = "Refusé";
        toast("Autorisez les capteurs pour la boussole");
        return;
      }
    } catch {
      state.compass.error = "Non supporté";
      toast("Boussole non disponible sur cet appareil");
      return;
    }
  }

  let lastUi = 0;
  const onOrientation = (event) => {
    let heading = null;
    if (Number.isFinite(event.webkitCompassHeading)) {
      heading = event.webkitCompassHeading;
    } else if (Number.isFinite(event.alpha)) {
      heading = (360 - event.alpha) % 360;
    }
    if (heading == null) return;
    state.compass.heading = heading;
    state.compass.estimatedClock = clockFromHeading(heading, state.beachBearing);

    const now = Date.now();
    if (now - lastUi > 120) {
      lastUi = now;
      updateHorlogeDial(heading);
    }
  };

  window.addEventListener("deviceorientationabsolute", onOrientation, true);
  window.addEventListener("deviceorientation", onOrientation, true);
  state.compass.watching = true;
  state.compass._onOrientation = onOrientation;
}

function stopCompass() {
  if (state.compass._onOrientation) {
    window.removeEventListener("deviceorientationabsolute", state.compass._onOrientation, true);
    window.removeEventListener("deviceorientation", state.compass._onOrientation, true);
    state.compass._onOrientation = null;
  }
  state.compass.watching = false;
  state.compass.heading = null;
  state.compass.estimatedClock = null;
  if (els.horlogeRotatingDial) els.horlogeRotatingDial.style.transform = "none";
}

function updateHorlogeDial(heading) {
  if (state.horlogeMode !== "adapted") return;

  if (heading == null) {
    if (els.horlogeRotatingDial) els.horlogeRotatingDial.style.transform = "none";
    if (els.horlogeAimValue) els.horlogeAimValue.textContent = "12h (Plage)";
    if (els.horlogeHeadingValue) els.horlogeHeadingValue.textContent = "—";
    document.querySelectorAll(".clock-face.is-adapted").forEach((face) => {
      face.style.setProperty("--dial-rot", "0deg");
    });
    return;
  }

  // Relative angle to beach (Beach = state.beachBearing):
  const relBeach = ((state.beachBearing - heading) % 360 + 360) % 360;
  if (els.horlogeRotatingDial) {
    els.horlogeRotatingDial.style.transform = `rotate(${relBeach}deg)`;
  }
  const clock = clockFromHeading(heading, state.beachBearing);
  if (els.horlogeAimValue) {
    els.horlogeAimValue.textContent = `${clock}h${clock === 12 ? " (Plage)" : ""}`;
  }
  if (els.horlogeHeadingValue) {
    els.horlogeHeadingValue.textContent = `${Math.round(heading)}°`;
  }

  // Rotate all AP and Camera dials in drawer in real time:
  document.querySelectorAll(".clock-face.is-adapted").forEach((face) => {
    face.style.setProperty("--dial-rot", `${relBeach}deg`);
  });

  // Update user gps marker cone heading if active
  const cone = document.getElementById("user-gps-cone");
  if (cone && state.gps.watching) {
    cone.style.display = "block";
    cone.style.transform = `translateX(-50%) rotate(${heading}deg)`;
  }

  // Update aim on drawer clock buttons if open
  if (state.selectedMatId) {
    document.querySelectorAll(".clock-card").forEach((card) => {
      card.querySelectorAll(".clock-hour").forEach((btn) => {
        const h = Number(btn.dataset.clockHour);
        btn.classList.toggle("suggest", h === clock);
      });
      const applyBtn = card.querySelector("[data-apply-estimate]");
      if (applyBtn) {
        applyBtn.textContent = `🎯 Viseur boussole → ${clock}h`;
      }
    });
  }
}

/**
 * 12h = Beach (Plage). Default is state.beachBearing (330° NW for Casablanca port).
 * Every 30 degrees clockwise corresponds to one hour.
 */
function clockFromHeading(headingDegrees, beachBearingDegrees = null) {
  if (!Number.isFinite(headingDegrees)) return null;
  const ref = beachBearingDegrees != null ? beachBearingDegrees : state.beachBearing;
  const relative = ((Number(headingDegrees) - Number(ref || 0)) % 360 + 360) % 360;
  let hour = Math.round(relative / 30) % 12;
  if (hour === 0) hour = 12;
  return hour;
}

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `sync-status${kind ? ` ${kind}` : ""}`;
}

function toast(message) {
  els.toast.hidden = false;
  els.toast.textContent = message;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2600);
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
