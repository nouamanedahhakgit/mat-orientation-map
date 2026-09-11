const CLOCK_COLORS = {
  1: "#ff6b6b",
  2: "#ff8e53",
  3: "#ffb347",
  4: "#ffd93d",
  5: "#c6e377",
  6: "#6bcb77",
  7: "#4dd0a0",
  8: "#4ecdc4",
  9: "#45b7d1",
  10: "#6c8cff",
  11: "#9b7bff",
  12: "#3ec7ff",
};

const DEFAULT_ZOOM = 17; // immersive dashboard was 19; −2 levels
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
    if (!payload.ok) throw new Error(payload.error || "Export failed");
    const mats = parseSheetValues(payload.values || []);
    state.mats = mats;
    state.lastUpdatedAt = payload.updatedAt || new Date().toISOString();
    renderMarkers();
    if (state.selectedMatId) {
      const still = mats.find((m) => m.matId === state.selectedMatId);
      if (still) renderDrawer(still);
      else closeDrawer();
    }
    setStatus(`Live · ${mats.length} MAT · ${formatTime(state.lastUpdatedAt)}`, "ok");
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
      else aps.push({ name, unit: guessUnit(name), clock });
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
    const color = primaryClockColor(mat);
    const icon = L.divIcon({
      className: "",
      html: `<div class="mat-marker" style="background:${color}"><span>${escapeHtml(mat.matId)}</span></div>`,
      iconSize: [44, 44],
      iconAnchor: [22, 22],
    });
    const marker = L.marker(latlng, { icon, title: `MAT ${mat.matId}` });
    marker.on("click", () => openDrawer(mat.matId));
    state.layer.addLayer(marker);

    L.circle(latlng, {
      radius: 18,
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.18,
      interactive: false,
    }).addTo(state.layer);
  }
  if (bounds.length && !state.selectedMatId) {
    // Keep current view on poll; only auto-fit when empty selection and first useful data.
    if (!state._didFit) {
      fitBounds(bounds);
      state._didFit = true;
    }
  }
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

function primaryClockColor(mat) {
  const clocks = [...(mat.aps || []), ...(mat.cameras || [])]
    .map((item) => item.clock)
    .filter((c) => c != null);
  if (!clocks.length) return "#6b7c86";
  const avg = Math.round(clocks.reduce((a, b) => a + b, 0) / clocks.length);
  return CLOCK_COLORS[((avg - 1) % 12) + 1] || "#6b7c86";
}

function openDrawer(matId) {
  const mat = state.mats.find((item) => item.matId === matId);
  if (!mat) return;
  state.selectedMatId = matId;
  if (mat.latitude != null && mat.longitude != null) {
    state.map.setView([mat.latitude, mat.longitude], DEFAULT_ZOOM, { animate: true });
  }
  renderDrawer(mat);
  els.drawer.hidden = false;
}

function closeDrawer() {
  state.selectedMatId = null;
  els.drawer.hidden = true;
}

function renderDrawer(mat) {
  els.drawerTitle.textContent = `MAT ${mat.matId}`;
  const gps =
    mat.latitude != null && mat.longitude != null
      ? `${mat.latitude}, ${mat.longitude}`
      : "No GPS in Excel yet";
  els.drawerMeta.textContent = [mat.terminal, gps].filter(Boolean).join(" · ");
  updateGpsAssistUi();

  const estimated = state.compass.estimatedClock;
  const sections = [];
  sections.push(`<h3 style="margin:4px 0 0;font-size:.8rem;color:var(--muted)">Access points</h3>`);
  if (!mat.aps.length) sections.push(`<p class="drawer-meta">No APs on this row</p>`);
  for (const ap of mat.aps) {
    sections.push(clockEditorCard({
      matId: mat.matId,
      kind: "ap",
      key: ap.unit || ap.name,
      label: ap.name || ap.unit,
      clock: ap.clock,
      estimated,
    }));
  }
  sections.push(`<h3 style="margin:12px 0 0;font-size:.8rem;color:var(--muted)">Cameras</h3>`);
  if (!mat.cameras.length) sections.push(`<p class="drawer-meta">No cameras on this row</p>`);
  for (const cam of mat.cameras) {
    sections.push(clockEditorCard({
      matId: mat.matId,
      kind: "camera",
      key: cam.name,
      label: cam.name,
      clock: cam.clock,
      estimated,
    }));
  }
  els.drawerBody.innerHTML = sections.join("");

  els.drawerBody.querySelectorAll("select.clock-select").forEach((select) => {
    select.addEventListener("change", () => {
      const value = select.value === "" ? null : Number(select.value);
      void saveOrientation({
        matId: select.dataset.matId,
        kind: select.dataset.kind,
        key: select.dataset.key,
        clock: value,
        select,
      });
    });
  });
  els.drawerBody.querySelectorAll("[data-apply-estimate]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.compass.estimatedClock == null) return;
      const select = button.closest(".clock-card")?.querySelector("select.clock-select");
      if (!select) return;
      select.value = String(state.compass.estimatedClock);
      void saveOrientation({
        matId: button.dataset.matId,
        kind: button.dataset.kind,
        key: button.dataset.key,
        clock: state.compass.estimatedClock,
        select,
      });
    });
  });
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
    els.gpsAssistText.innerHTML = `Phone ~${heading != null ? `${Math.round(heading)}°` : "—"} → suggest <b>${estimatedClock}</b>. Beach = <b>12</b>. Point at each AP/camera and set it.`;
  } else if (watching) {
    els.gpsAssistText.innerHTML = `Point phone to the <b>beach (12)</b> first, then toward each AP or camera.`;
  } else {
    els.gpsAssistText.innerHTML = `Turn it on to find the <b>beach (12)</b>, then set each AP and camera.`;
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
    toast("GPS/compass on — point to beach (12), then each device");
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
    state.compass.error = "No compass here — look to beach (12) and set each AP/camera manually";
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

function clockEditorCard({ matId, kind, key, label, clock, estimated = null }) {
  const options = [`<option value="">—</option>`]
    .concat(Array.from({ length: 12 }, (_, i) => {
      const hour = i + 1;
      const selected = Number(clock) === hour ? "selected" : "";
      const suggest = Number(estimated) === hour ? " ★" : "";
      return `<option value="${hour}" ${selected}>${hour}${hour === 12 ? " (beach)" : ""}${suggest}</option>`;
    }))
    .join("");
  const bg = clock != null ? CLOCK_COLORS[clock] : "transparent";
  return `<div class="clock-card" data-key="${escapeHtml(key)}">
    <div class="label"><b>${escapeHtml(label)}</b><span style="color:${bg === "transparent" ? "var(--muted)" : bg}">${clock ?? "unset"}</span></div>
    <select class="clock-select" data-mat-id="${escapeHtml(matId)}" data-kind="${escapeHtml(kind)}" data-key="${escapeHtml(key)}" style="border-color:${bg === "transparent" ? "var(--line)" : bg}">
      ${options}
    </select>
    ${estimated != null
      ? `<button type="button" class="ghost" data-apply-estimate data-mat-id="${escapeHtml(matId)}" data-kind="${escapeHtml(kind)}" data-key="${escapeHtml(key)}">Use compass → ${estimated}</button>`
      : ""}
  </div>`;
}

async function saveOrientation({ matId, kind, key, clock, select }) {
  const card = select.closest(".clock-card");
  if (card) card.classList.add("is-pending");
  select.disabled = true;
  const patch = { matId, aps: {}, cameras: {} };
  if (kind === "ap") patch.aps[key] = clock;
  else patch.cameras[key] = clock;

  // Optimistic local update
  const mat = state.mats.find((item) => item.matId === matId);
  if (mat) {
    const list = kind === "ap" ? mat.aps : mat.cameras;
    const item = list.find((row) => (row.unit || row.name) === key || row.name === key);
    if (item) item.clock = clock;
    renderMarkers();
  }

  try {
    const payload = await postSheet({ mode: "patch", patch });
    if (!payload.ok) throw new Error(payload.error || "Patch failed");
    toast(`Saved MAT ${matId}`);
    setStatus(`Saved · ${formatTime(new Date().toISOString())}`, "ok");
  } catch (error) {
    toast(error.message || "Save failed");
    setStatus(error.message || "Save failed", "err");
    await loadSheet(false);
  } finally {
    select.disabled = false;
    if (card) card.classList.remove("is-pending");
    if (mat) renderDrawer(mat);
  }
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
