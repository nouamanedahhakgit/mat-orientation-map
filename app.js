const DEFAULT_ZOOM = 17;
const POLL_MS = 8000;
const API_PATH = "/api/sheet";

const state = {
  map: null,
  layer: null,
  mats: [],
  selectedMatId: null,
  pollTimer: null,
  lastUpdatedAt: null,
  toastTimer: null,
  _didFit: false,
  pending: Object.create(null),
  compass: {
    watching: false,
    heading: null,
    estimatedClock: null,
    error: null,
    _onOrientation: null,
  },
};

const els = {
  status: document.querySelector("#sync-status"),
  refresh: document.querySelector("#btn-refresh"),
  fit: document.querySelector("#btn-fit"),
  drawer: document.querySelector("#drawer"),
  drawerTitle: document.querySelector("#drawer-title"),
  drawerMeta: document.querySelector("#drawer-meta"),
  drawerBody: document.querySelector("#drawer-body"),
  drawerClose: document.querySelector("#drawer-close"),
  toast: document.querySelector("#toast"),
  gpsAssist: document.querySelector("#gps-assist"),
  gpsAssistText: document.querySelector("#gps-assist-text"),
  gpsAssistBtn: document.querySelector("#gps-assist-btn"),
};

els.refresh.addEventListener("click", () => loadSheet(true));
els.fit.addEventListener("click", fitMap);
els.drawerClose.addEventListener("click", closeDrawer);
els.gpsAssistBtn?.addEventListener("click", toggleCompassAssist);

initMap();
loadSheet(true);
state.pollTimer = setInterval(() => loadSheet(false), POLL_MS);

function initMap() {
  state.map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
    maxZoom: 19,
  }).setView([33.5731, -7.5898], DEFAULT_ZOOM);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(state.map);

  state.layer = L.layerGroup().addTo(state.map);
}

async function loadSheet(showBusy = false) {
  if (showBusy) setStatus("Loading Excel…");
  try {
    const payload = await postSheet({ mode: "export" });
    if (!payload.ok) throw new Error(payload.error || payload.hint || "Export failed");
    const mats = parseSheetValues(payload.values || []);
    state.mats = mats;
    state.lastUpdatedAt = payload.updatedAt || new Date().toISOString();
    renderMarkers();
    if (state.selectedMatId) {
      const still = mats.find((m) => m.matId === state.selectedMatId);
      if (still) renderDrawer(still);
      else closeDrawer();
    }
    const withGps = mats.filter((m) => m.latitude != null && m.longitude != null).length;
    setStatus(`Live · ${withGps}/${mats.length} MAT on map · ${formatTime(state.lastUpdatedAt)}`, "ok");
  } catch (error) {
    setStatus(error.message || "Sync failed", "err");
    if (showBusy) toast(error.message || "Could not load Excel");
  }
}

async function postSheet(body) {
  const response = await fetch(API_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && payload.error) throw new Error(payload.error);
  if (!response.ok) throw new Error(`Sheet API ${response.status}`);
  return payload;
}

function parseSheetValues(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const headers = values[0].map((cell) => String(cell ?? "").trim());
  const latCol = headers.findIndex((h) => /^(latitude|lat)$/i.test(h));
  const lngCol = headers.findIndex((h) => /^(longitude|lng|lon)$/i.test(h));
  const termCol = headers.findIndex((h) => /^terminal$/i.test(h));

  const mats = [];
  for (let r = 1; r < values.length; r += 1) {
    const row = values[r] || [];
    const matId = String(row[0] ?? "").trim();
    if (!matId) continue;

    const latitude = latCol >= 0 ? Number(row[latCol]) : NaN;
    const longitude = lngCol >= 0 ? Number(row[lngCol]) : NaN;
    const terminal = termCol >= 0 ? String(row[termCol] ?? "").trim() : "";

    const aps = [];
    const cameras = [];
    for (let c = 1; c < headers.length - 1; c += 1) {
      if (String(headers[c + 1] || "").toLowerCase() !== "value") continue;
      const header = String(headers[c] || "").trim();
      if (/^(terminal|latitude|longitude|lat|lng|lon)$/i.test(header)) continue;
      const name = String(row[c] ?? "").trim();
      if (!name) continue;
      const clock = parseClock(row[c + 1]);
      if (/^CAM\d+$/i.test(header)) cameras.push({ name, clock });
      else aps.push({ name, unit: guessUnit(name) || header, clock });
    }

    mats.push({
      matId,
      terminal,
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
      aps,
      cameras,
    });
  }
  return mats;
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

  if (bounds.length && !state._didFit && !state.selectedMatId) {
    fitBounds(bounds);
    state._didFit = true;
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

function matClockMarkerHtml(mat, devices, selected = false) {
  const hub = `${mat.aps.length}·${mat.cameras.length}`;
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
  return `<div class="mat-clock-marker${selected ? " is-selected" : ""}" title="MAT ${escapeHtml(mat.matId)}">
    <div class="mat-clock-ring">
      <span class="mat-clock-beach" title="Beach · 12">B</span>
      ${ticks}
      ${nodes}
      <div class="mat-clock-hub" title="APs · Cameras">${escapeHtml(hub)}</div>
    </div>
    <div class="mat-clock-caption">MAT ${escapeHtml(mat.matId)}</div>
  </div>`;
}

function fitMap() {
  const bounds = state.mats
    .filter((m) => m.latitude != null && m.longitude != null)
    .map((m) => [m.latitude, m.longitude]);
  fitBounds(bounds);
}

function fitBounds(bounds) {
  if (!bounds.length) return;
  if (bounds.length === 1) {
    state.map.setView(bounds[0], DEFAULT_ZOOM, { animate: true });
    return;
  }
  state.map.fitBounds(bounds, { padding: [48, 48], maxZoom: DEFAULT_ZOOM });
}

function openDrawer(matId) {
  const mat = state.mats.find((item) => item.matId === matId);
  if (!mat) return;
  state.selectedMatId = matId;
  renderMarkers();
  if (mat.latitude != null && mat.longitude != null) {
    state.map.setView([mat.latitude, mat.longitude], DEFAULT_ZOOM, { animate: true });
  }
  renderDrawer(mat);
  els.drawer.hidden = false;
}

function closeDrawer() {
  state.selectedMatId = null;
  els.drawer.hidden = true;
  renderMarkers();
}

function renderDrawer(mat) {
  els.drawerTitle.textContent = `MAT ${mat.matId}`;
  const gps =
    mat.latitude != null && mat.longitude != null
      ? `${mat.latitude}, ${mat.longitude}`
      : "No GPS in Excel";
  els.drawerMeta.textContent = `${mat.terminal || ""} · ${mat.aps.length} AP · ${mat.cameras.length} cam · ${gps}`.replace(/^ · /, "");
  updateGpsAssistUi();

  const estimated = state.compass.estimatedClock;
  const cards = [];
  for (const ap of mat.aps) {
    const key = ap.unit || ap.name;
    cards.push(`<div class="ori-clock-wrap">
      <span class="ori-kind">AP</span>
      ${renderClockCard("ap", key, ap.name || key, ap.clock, estimated, mat.matId)}
    </div>`);
  }
  for (const cam of mat.cameras) {
    cards.push(`<div class="ori-clock-wrap">
      <span class="ori-kind cam">CAM</span>
      ${renderClockCard("camera", cam.name, "Camera", cam.clock, estimated, mat.matId)}
    </div>`);
  }
  els.drawerBody.innerHTML = cards.length
    ? cards.join("")
    : `<div class="sync-status">No APs or cameras on this MAT row</div>`;

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
}

function renderClockCard(kind, key, subtitle, clock, estimated, matId) {
  const hours = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const pendingKey = `${matId}:${kind}:${key}`;
  const pending = Boolean(state.pending[pendingKey]);
  return `
    <article class="clock-card ${pending ? "is-pending" : ""}" data-kind="${escapeHtml(kind)}" data-key="${escapeHtml(key)}" data-mat-id="${escapeHtml(matId)}">
      <div class="clock-card-head">
        <div>
          <strong>${escapeHtml(key)}</strong>
          <small>${escapeHtml(subtitle || "")}</small>
        </div>
        <div class="clock-value">${clock != null ? clock : "—"}</div>
      </div>
      <div class="clock-face" aria-label="Clock orientation for ${escapeHtml(key)}">
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
      </div>
      <div class="clock-save-status" ${pending ? "" : "hidden"}>${pending ? "Saving…" : ""}</div>
      ${estimated != null
        ? `<button type="button" class="secondary-button clock-apply" data-apply-estimate data-kind="${escapeHtml(kind)}" data-key="${escapeHtml(key)}" data-mat-id="${escapeHtml(matId)}" ${pending ? "disabled" : ""}>Use compass → ${estimated}</button>`
        : ""}
    </article>`;
}

async function saveOrientation({ matId, kind, key, clock }) {
  const pendingKey = `${matId}:${kind}:${key}`;
  state.pending[pendingKey] = true;
  const mat = state.mats.find((item) => item.matId === matId);
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
    toast(clock == null ? `${key} cleared` : `${key} → ${clock}`);
    setStatus(`Saved · ${formatTime(new Date().toISOString())}`, "ok");
  } catch (error) {
    toast(error.message || "Save failed");
    setStatus(error.message || "Save failed", "err");
    await loadSheet(false);
  } finally {
    delete state.pending[pendingKey];
    const again = state.mats.find((item) => item.matId === matId);
    if (again && state.selectedMatId === matId) renderDrawer(again);
  }
}

function updateGpsAssistUi() {
  if (!els.gpsAssist || !els.gpsAssistText || !els.gpsAssistBtn) return;
  const { watching, estimatedClock, heading, error } = state.compass;
  els.gpsAssist.classList.toggle("is-active", watching);
  els.gpsAssist.classList.toggle("is-ready", estimatedClock != null);
  els.gpsAssistBtn.textContent = watching ? "Stop GPS" : "Activate GPS";
  if (error) {
    els.gpsAssistText.textContent = error;
  } else if (watching && estimatedClock != null) {
    els.gpsAssistText.innerHTML = `Phone ~${heading != null ? `${Math.round(heading)}°` : "—"} → suggest <b>${estimatedClock}</b>. Beach = <b>12</b>. Tap hour on each dial.`;
  } else if (watching) {
    els.gpsAssistText.innerHTML = `Point phone to the <b>beach (12)</b>, then toward each AP or camera.`;
  } else {
    els.gpsAssistText.innerHTML = `Turn it on to find the <b>beach (12)</b>, then set each AP and camera on the horloge.`;
  }
}

function toggleCompassAssist() {
  if (state.compass.watching) {
    stopCompassAssist();
    return;
  }
  startCompassAssist();
}

function startCompassAssist() {
  state.compass.error = null;
  let lastUi = 0;
  const onOrientation = (event) => {
    const heading = Number.isFinite(event.webkitCompassHeading)
      ? event.webkitCompassHeading
      : (Number.isFinite(event.alpha) ? (360 - event.alpha) % 360 : null);
    if (heading == null) return;
    state.compass.heading = heading;
    state.compass.estimatedClock = clockFromHeading(heading, 0);
    const now = Date.now();
    if (now - lastUi < 400) return;
    lastUi = now;
    const mat = state.mats.find((item) => item.matId === state.selectedMatId);
    if (mat) renderDrawer(mat);
    else updateGpsAssistUi();
  };
  const bind = () => {
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
    window.addEventListener("deviceorientation", onOrientation, true);
    state.compass.watching = true;
    state.compass._onOrientation = onOrientation;
    toast("GPS/compass on — beach is 12");
    updateGpsAssistUi();
  };
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission()
      .then((permission) => {
        if (permission !== "granted") {
          state.compass.error = "Allow motion/compass so we can show beach direction";
          toast(state.compass.error);
          updateGpsAssistUi();
          return;
        }
        bind();
        requestGpsFix();
      })
      .catch(() => {
        state.compass.error = "Unable to enable compass on this device";
        toast(state.compass.error);
        updateGpsAssistUi();
      });
    return;
  }
  if (!window.DeviceOrientationEvent) {
    state.compass.error = "No compass here — set each AP/camera manually on the dial";
    toast(state.compass.error);
    updateGpsAssistUi();
    return;
  }
  bind();
  requestGpsFix();
}

function requestGpsFix() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    () => toast("GPS ready — beach is 12 on the clock"),
    (error) => {
      if (error?.code === 1) toast("Allow location to help find beach direction");
    },
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

function stopCompassAssist() {
  if (state.compass._onOrientation) {
    window.removeEventListener("deviceorientationabsolute", state.compass._onOrientation, true);
    window.removeEventListener("deviceorientation", state.compass._onOrientation, true);
  }
  state.compass.watching = false;
  state.compass._onOrientation = null;
  state.compass.heading = null;
  state.compass.estimatedClock = null;
  state.compass.error = null;
  const mat = state.mats.find((item) => item.matId === state.selectedMatId);
  if (mat) renderDrawer(mat);
  else updateGpsAssistUi();
}

function clockFromHeading(headingDegrees, beachBearingDegrees = 0) {
  if (!Number.isFinite(headingDegrees)) return null;
  const relative = ((Number(headingDegrees) - Number(beachBearingDegrees || 0)) % 360 + 360) % 360;
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
