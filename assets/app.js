/**
 * Reads the snapshot written by scripts/fetch-quakes.mjs and renders it.
 *
 * The Kandilli API bans IPs that exceed 40 requests/minute, so the browser
 * never talks to it directly — it only polls this repo's own snapshot file.
 */

const SNAPSHOT_URL = "data/istanbul.json";
const POLL_INTERVAL_MS = 60_000;

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
let lastFetchFailed = false;

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

  const generated = Date.parse(snapshot.generated_at);
  const parts = [`${filtered.length} deprem listeleniyor`];
  if (Number.isFinite(generated)) {
    parts.push(`veriler ${formatRelative(generated)} güncellendi (${istanbulTime.format(generated)})`);
  }
  if (lastFetchFailed) parts.push("son yenileme başarısız oldu, önceki veriler gösteriliyor");
  statusEl.textContent = `${parts.join(" · ")}.`;
  statusEl.classList.toggle("status--stale", lastFetchFailed);
}

async function load() {
  refreshBtn.disabled = true;
  try {
    // Cache-bust so a redeployed snapshot is picked up without a hard reload.
    const res = await fetch(`${SNAPSHOT_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.quakes)) throw new Error("beklenmeyen veri biçimi");

    snapshot = data;
    lastFetchFailed = false;
  } catch (err) {
    lastFetchFailed = true;
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
