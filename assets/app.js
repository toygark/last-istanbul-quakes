/**
 * Reads the snapshot written by scripts/fetch-quakes.mjs and renders it.
 *
 * The snapshot is the normal source: it costs the upstream API one fetch per
 * scheduled run no matter how many people are reading. But GitHub's `schedule`
 * events are best-effort and routinely skipped, so when the snapshot has gone
 * stale the browser falls back to querying the API directly. That path is
 * throttled hard and only runs while the snapshot is behind -- the API's rate
 * limit is per IP, so one call per visitor every few minutes is negligible for
 * them, but there is no reason to make it whenever the snapshot is current.
 */

import { API_BASE, mergeQuakes, normalise, searchBody } from "./quakes.js";

const SNAPSHOT_URL = "data/istanbul.json";
const POLL_INTERVAL_MS = 60_000;

/** Snapshot older than this and we consider going to the API ourselves. */
const STALE_AFTER_MS = 10 * 60_000;
/** Never hit the API more often than this from one browser. */
const LIVE_MIN_INTERVAL_MS = 5 * 60_000;
/** After this many consecutive failures (no CORS, offline), stop trying. */
const LIVE_MAX_FAILURES = 3;
const LIVE_ATTEMPT_KEY = "last-istanbul-quakes:last-live-attempt";

const listEl = document.getElementById("quakes");
const statusEl = document.getElementById("status");
const emptyEl = document.getElementById("empty");
const refreshBtn = document.getElementById("refresh");
const radiusEl = document.getElementById("radius");
const minMagEl = document.getElementById("minmag");
const periodEl = document.getElementById("period");

const istanbulTime = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "Europe/Istanbul",
});
const relativeTime = new Intl.RelativeTimeFormat("tr-TR", { numeric: "auto" });

let snapshot = null;
let snapshotFetchFailed = false;
/** When we last pulled live data straight from the API, if ever. */
let liveAt = null;
let liveFailures = 0;

/** Coarse magnitude bands, used for colour and for the screen-reader label. */
function magBand(mag) {
  if (mag >= 5) return { key: "severe", label: "şiddetli" };
  if (mag >= 4) return { key: "strong", label: "kuvvetli" };
  if (mag >= 3) return { key: "moderate", label: "orta" };
  return { key: "light", label: "hafif" };
}

function formatRelative(timestamp) {
  const diffSec = Math.round((timestamp - Date.now()) / 1000);
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, seconds] of units) {
    if (Math.abs(diffSec) >= seconds) {
      return relativeTime.format(Math.round(diffSec / seconds), unit);
    }
  }
  return relativeTime.format(diffSec, "second");
}

/** Age of the data on screen, whether it came from the snapshot or the API. */
function dataTimestamp() {
  const generated = Date.parse(snapshot?.generated_at ?? "");
  const generatedMs = Number.isFinite(generated) ? generated : null;
  if (liveAt && generatedMs) return Math.max(liveAt, generatedMs);
  return liveAt ?? generatedMs;
}

function applyFilters(quakes) {
  const radius = radiusEl.value;
  const minMag = Number(minMagEl.value);
  const hours = Number(periodEl.value);
  const cutoff = hours > 0 ? Date.now() - hours * 3600_000 : null;

  return quakes.filter((q) => {
    if (q.mag < minMag) return false;
    if (cutoff !== null && q.timestamp < cutoff) return false;
    if (radius === "istanbul") return q.is_istanbul;
    return q.distance_km <= Number(radius);
  });
}

function renderQuake(q) {
  const band = magBand(q.mag);
  const li = document.createElement("li");
  li.className = `quake quake--${band.key}`;

  const mag = document.createElement("div");
  mag.className = "quake__mag";
  mag.textContent = q.mag.toFixed(1);
  mag.setAttribute("aria-label", `Büyüklük ${q.mag.toFixed(1)}, ${band.label}`);

  const body = document.createElement("div");
  body.className = "quake__body";

  const title = document.createElement("h2");
  title.className = "quake__title";
  title.textContent = q.title;

  const when = document.createElement("p");
  when.className = "quake__when";
  const abs = document.createElement("time");
  abs.dateTime = new Date(q.timestamp).toISOString();
  abs.textContent = istanbulTime.format(q.timestamp);
  when.append(abs, ` · ${formatRelative(q.timestamp)}`);

  const meta = document.createElement("ul");
  meta.className = "quake__meta";
  const facts = [
    ["Derinlik", Number.isFinite(q.depth) ? `${q.depth} km` : "—"],
    ["Merkeze uzaklık", `${q.distance_km} km`],
    ["Kaynak", q.provider === "kandilli" ? "Kandilli" : q.provider === "afad" ? "AFAD" : q.provider],
  ];
  if (q.closest_city) facts.splice(2, 0, ["En yakın il", q.closest_city]);

  for (const [label, value] of facts) {
    const item = document.createElement("li");
    item.innerHTML = `<span class="k"></span> <span class="v"></span>`;
    item.querySelector(".k").textContent = `${label}:`;
    item.querySelector(".v").textContent = value;
    meta.append(item);
  }

  const map = document.createElement("a");
  map.className = "quake__map";
  map.href = `https://www.openstreetmap.org/?mlat=${q.lat}&mlon=${q.lon}#map=9/${q.lat}/${q.lon}`;
  map.rel = "noopener";
  map.target = "_blank";
  map.textContent = "Haritada gör";

  body.append(title, when, meta, map);
  li.append(mag, body);
  return li;
}

function render() {
  if (!snapshot) return;

  const filtered = applyFilters(snapshot.quakes);
  listEl.replaceChildren(...filtered.map(renderQuake));
  emptyEl.hidden = filtered.length > 0;
  emptyEl.textContent =
    snapshot.quakes.length === 0
      ? "Henüz deprem verisi alınmadı. İlk güncelleme çalıştığında liste burada görünecek."
      : "Seçilen filtrelere uyan deprem kaydı yok.";

  const at = dataTimestamp();
  const parts = [`${filtered.length} deprem listeleniyor`];
  if (at !== null) {
    parts.push(`veriler ${formatRelative(at)} güncellendi (${istanbulTime.format(at)})`);
  }
  if (liveAt) parts.push("doğrudan API'den alındı");
  if (snapshotFetchFailed) parts.push("son yenileme başarısız oldu, önceki veriler gösteriliyor");

  const stale = at !== null && Date.now() - at > STALE_AFTER_MS;
  if (stale && liveFailures >= LIVE_MAX_FAILURES) {
    parts.push("canlı veri alınamıyor");
  }

  statusEl.textContent = `${parts.join(" · ")}.`;
  statusEl.classList.toggle("status--stale", snapshotFetchFailed || stale);
}

function lastLiveAttempt() {
  try {
    return Number(sessionStorage.getItem(LIVE_ATTEMPT_KEY)) || 0;
  } catch {
    return 0; // Private mode or blocked storage; the in-memory guards still apply.
  }
}

function markLiveAttempt() {
  try {
    sessionStorage.setItem(LIVE_ATTEMPT_KEY, String(Date.now()));
  } catch {
    /* not fatal */
  }
}

/**
 * Query the API directly. Only called when the snapshot has fallen behind --
 * see the note at the top of this file.
 */
async function loadLive() {
  if (liveFailures >= LIVE_MAX_FAILURES) return;
  if (Date.now() - lastLiveAttempt() < LIVE_MIN_INTERVAL_MS) return;
  markLiveAttempt();

  try {
    const res = await fetch(`${API_BASE}/data/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(searchBody({ limit: 100 })),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = await res.json();
    if (body?.status === false) throw new Error(body?.desc ?? "API reported failure");

    const fresh = (Array.isArray(body?.result) ? body.result : [])
      .map(normalise)
      .filter(Boolean);
    if (fresh.length === 0) throw new Error("no usable records");

    // Keep the snapshot's longer history and layer the newer events on top.
    snapshot = { ...snapshot, quakes: mergeQuakes(fresh, snapshot?.quakes ?? []) };
    liveAt = Date.now();
    liveFailures = 0;
  } catch {
    // Most likely the API sends no CORS headers for this origin, in which case
    // retrying will never help -- so give up for the session after a few tries
    // and keep showing the snapshot.
    liveFailures += 1;
  }
  render();
}

async function load() {
  refreshBtn.disabled = true;
  try {
    // Cache-bust so a redeployed snapshot is picked up without a hard reload.
    const res = await fetch(`${SNAPSHOT_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.quakes)) throw new Error("beklenmeyen veri biçimi");

    const generated = Date.parse(data.generated_at ?? "");
    // A newer snapshot supersedes whatever we pulled live earlier.
    if (Number.isFinite(generated) && liveAt && generated > liveAt) liveAt = null;

    snapshot = liveAt
      ? { ...data, quakes: mergeQuakes(snapshot?.quakes ?? [], data.quakes) }
      : data;
    snapshotFetchFailed = false;
  } catch (err) {
    snapshotFetchFailed = true;
    if (!snapshot) {
      statusEl.textContent = `Veriler yüklenemedi (${err.message}). Birazdan yeniden denenecek.`;
      statusEl.classList.add("status--stale");
      refreshBtn.disabled = false;
      return;
    }
  } finally {
    refreshBtn.disabled = false;
  }

  render();

  const at = dataTimestamp();
  if (at === null || Date.now() - at > STALE_AFTER_MS) await loadLive();
}

for (const el of [radiusEl, minMagEl, periodEl]) {
  el.addEventListener("change", render);
}
refreshBtn.addEventListener("click", load);

// Keep the "x minutes ago" labels honest between polls.
setInterval(render, 30_000);
setInterval(load, POLL_INTERVAL_MS);

// A backgrounded tab gets throttled; catch up as soon as it is visible again.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") load();
});

load();
