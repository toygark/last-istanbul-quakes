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

import { API_BASE, mergeQuakes, normalise, searchBody } from "./quakes.js?v=3";

const SNAPSHOT_URL = "data/istanbul.json";
const POLL_INTERVAL_MS = 60_000;

/** Snapshot older than this and we consider going to the API ourselves. */
const STALE_AFTER_MS = 10 * 60_000;
/** Never hit the API more often than this from one browser on its own. */
const LIVE_MIN_INTERVAL_MS = 5 * 60_000;
/**
 * Floor for user-initiated refreshes. The throttle above lives in
 * sessionStorage and so survives a reload -- without this exemption, pull to
 * refresh (which *is* a reload) would silently skip the live fetch and
 * re-render the same stale snapshot, making the page look frozen.
 */
const LIVE_MIN_INTERVAL_FORCED_MS = 15_000;
/** After this many consecutive failures (no CORS, offline), stop trying. */
const LIVE_MAX_FAILURES = 3;
const LIVE_ATTEMPT_KEY = "last-istanbul-quakes:last-live-attempt";
/**
 * Live results are cached alongside the attempt timestamp so a reload keeps
 * them. Without this, every pull to refresh drops back to the (stale) snapshot
 * and the page appears to go backwards in time until the throttle allows
 * another API call.
 */
const LIVE_CACHE_KEY = "last-istanbul-quakes:live";
/**
 * Which quakes the reader has already been shown. Persisted so the "YENİ"
 * badges mean "arrived since your last visit", not "since this tab opened".
 */
const SEEN_KEY = "last-istanbul-quakes:seen";
/**
 * The badges of the current visit, kept per tab so a pull to refresh (a real
 * reload) does not wipe the marks the reader has not looked at yet.
 */
const NEW_KEY = "last-istanbul-quakes:new";
/** Ids remembered as seen; comfortably more than one snapshot holds. */
const SEEN_LIMIT = 400;
/**
 * Kandilli and AFAD publish some events minutes after they happen, so an event
 * can be older than the moment we last recorded what the reader saw and still
 * be new to them. The id list is what actually prevents re-flagging; this only
 * keeps a growing history window from flooding the list with badges.
 */
const NEW_GRACE_MS = 2 * 3600_000;

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

// Compact variants for the list rows: the full timestamp stays available as a
// tooltip and in the <time datetime> attribute.
const istanbulDay = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit",
});
const istanbulClock = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit",
});
const istanbulShortDate = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul", day: "numeric", month: "short",
});

/** Clock time for today's quakes, date + clock for older ones. */
function compactTime(timestamp) {
  const clock = istanbulClock.format(timestamp);
  if (istanbulDay.format(timestamp) === istanbulDay.format(Date.now())) return clock;
  return `${istanbulShortDate.format(timestamp)} ${clock}`;
}

let snapshot = null;
let snapshotFetchFailed = false;
/** When we last pulled live data straight from the API, if ever. */
let liveAt = null;
let liveFailures = 0;
/** Ids flagged as new during this visit; they stay flagged until it ends. */
let newIds = readNewCache();

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

  // Row 1: title (linking to the map, which saves a whole line) and the clock.
  const head = document.createElement("div");
  head.className = "quake__head";

  const title = document.createElement("h2");
  title.className = "quake__title";
  const link = document.createElement("a");
  link.href = `https://www.openstreetmap.org/?mlat=${q.lat}&mlon=${q.lon}#map=9/${q.lat}/${q.lon}`;
  link.rel = "noopener";
  link.target = "_blank";
  link.textContent = q.title;
  link.title = "Haritada gör";
  title.append(link);

  const abs = document.createElement("time");
  abs.className = "quake__clock";
  abs.dateTime = new Date(q.timestamp).toISOString();
  abs.textContent = compactTime(q.timestamp);
  abs.title = istanbulTime.format(q.timestamp);

  head.append(title, abs);

  if (newIds.has(q.id)) {
    li.classList.add("quake--new");
    const badge = document.createElement("span");
    badge.className = "quake__new";
    badge.textContent = "YENİ";
    badge.title = "Son güncellemeden sonra listeye eklendi";
    head.prepend(badge);
  }

  // Row 2: everything else, on one line.
  const meta = document.createElement("p");
  meta.className = "quake__meta";
  const facts = [
    formatRelative(q.timestamp),
    Number.isFinite(q.depth) ? `derinlik ${q.depth} km` : null,
    `uzaklık ${q.distance_km} km`,
    q.closest_city,
    q.provider === "kandilli" ? "Kandilli" : q.provider === "afad" ? "AFAD" : q.provider,
  ].filter(Boolean);
  meta.textContent = facts.join(" · ");

  body.append(head, meta);
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
  const newCount = filtered.reduce((n, q) => n + (newIds.has(q.id) ? 1 : 0), 0);
  const parts = [`${filtered.length} deprem listeleniyor`];
  if (newCount > 0) parts.push(`${newCount} yeni`);
  if (at !== null) {
    parts.push(`veriler ${formatRelative(at)} güncellendi (${istanbulTime.format(at)})`);
  }
  if (liveAt) parts.push("doğrudan API'den alındı");
  if (snapshotFetchFailed) parts.push("son yenileme başarısız oldu, önceki veriler gösteriliyor");

  const stale = at !== null && Date.now() - at > STALE_AFTER_MS;
  if (stale && liveFailures > 0) parts.push("canlı veri alınamadı");

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

function readLiveCache() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(LIVE_CACHE_KEY) ?? "null");
    if (!Array.isArray(parsed?.quakes) || !Number.isFinite(parsed?.at)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLiveCache(at, quakes) {
  try {
    sessionStorage.setItem(LIVE_CACHE_KEY, JSON.stringify({ at, quakes }));
  } catch {
    /* quota or private mode; the in-memory copy still serves this page view */
  }
}

function readSeen() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null");
    if (!Array.isArray(parsed?.ids) || !Number.isFinite(parsed?.at)) return null;
    return { at: parsed.at, ids: new Set(parsed.ids) };
  } catch {
    return null; // Private mode or blocked storage: no badges, no crash.
  }
}

function writeSeen(quakes) {
  try {
    const ids = quakes.slice(0, SEEN_LIMIT).map((q) => q.id);
    localStorage.setItem(SEEN_KEY, JSON.stringify({ at: Date.now(), ids }));
  } catch {
    /* not fatal */
  }
}

function readNewCache() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(NEW_KEY) ?? "null");
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function writeNewCache() {
  try {
    sessionStorage.setItem(NEW_KEY, JSON.stringify([...newIds]));
  } catch {
    /* not fatal */
  }
}

/**
 * Flag whatever the reader has not been shown before, then record the current
 * list as seen. Called on every data update, so the flags accumulate through a
 * visit: quakes that land while the page is open stay marked alongside the
 * ones that were already new when it opened.
 */
function markNewQuakes(quakes) {
  const seen = readSeen();
  // On a first visit the whole list is the baseline, not news.
  if (seen) {
    for (const q of quakes) {
      if (!seen.ids.has(q.id) && q.timestamp > seen.at - NEW_GRACE_MS) newIds.add(q.id);
    }
  }
  writeSeen(quakes);
  writeNewCache();
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
async function loadLive({ force = false } = {}) {
  if (liveFailures >= LIVE_MAX_FAILURES) return;
  const floor = force ? LIVE_MIN_INTERVAL_FORCED_MS : LIVE_MIN_INTERVAL_MS;
  if (Date.now() - lastLiveAttempt() < floor) return;
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
    markNewQuakes(snapshot.quakes);
    liveAt = Date.now();
    liveFailures = 0;
    writeLiveCache(liveAt, fresh);
  } catch {
    // Most likely the API sends no CORS headers for this origin, in which case
    // retrying will never help -- so give up for the session after a few tries
    // and keep showing the snapshot.
    liveFailures += 1;
  }
  render();
}

async function load({ force = false } = {}) {
  refreshBtn.disabled = true;
  try {
    // Cache-bust so a redeployed snapshot is picked up without a hard reload.
    const res = await fetch(`${SNAPSHOT_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.quakes)) throw new Error("beklenmeyen veri biçimi");

    const generated = Date.parse(data.generated_at ?? "");
    const snapshotAt = Number.isFinite(generated) ? generated : 0;

    // Whichever is newer wins: a fresh snapshot supersedes older live results,
    // and cached live results (which survive a reload) supersede an older
    // snapshot. Reading the cache here is what makes pull to refresh keep the
    // data it already had instead of falling back to the snapshot.
    const cachedLive = readLiveCache();
    const live = cachedLive && cachedLive.at > snapshotAt ? cachedLive : null;

    liveAt = live?.at ?? null;
    snapshot = live ? { ...data, quakes: mergeQuakes(live.quakes, data.quakes) } : data;
    markNewQuakes(snapshot.quakes);
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
  if (at === null || Date.now() - at > STALE_AFTER_MS) await loadLive({ force });
}

for (const el of [radiusEl, minMagEl, periodEl]) {
  el.addEventListener("change", render);
}
refreshBtn.addEventListener("click", () => load({ force: true }));

// Keep the "x minutes ago" labels honest between polls.
setInterval(render, 30_000);
setInterval(load, POLL_INTERVAL_MS);

// A backgrounded tab gets throttled; catch up as soon as it is visible again.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") load();
});

load({ force: true });
