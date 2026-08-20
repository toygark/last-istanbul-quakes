#!/usr/bin/env node
/**
 * Fetches recent earthquakes around Istanbul from the Kandilli Rasathanesi API
 * (https://github.com/orhanayd/kandilli-rasathanesi-api) and writes a snapshot
 * to data/istanbul.json.
 *
 * The API rate-limits to 40 requests/minute per IP and auto-bans offenders for
 * 72 hours, so the site never calls it from the browser: this script runs on a
 * schedule and every visitor reads the committed snapshot instead.
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = resolve(ROOT, "data/istanbul.json");

const API_BASE = process.env.API_BASE ?? "https://api.orhanaydogdu.com.tr/deprem";

// Sultanahmet, taken as the city centre for distance calculations.
const ISTANBUL = { lat: 41.0082, lon: 28.9784 };

// Search radius sent to the API. The UI narrows this down further; keeping a
// wide radius here means changing the on-site filter needs no new fetch.
const RADIUS_METER = Number(process.env.RADIUS_METER ?? 250_000);
const PAGE_SIZE = 100; // API hard-caps limit at 100
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 3);
const ISTANBUL_CITY_CODE = 34;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Great-circle distance in kilometres. */
function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The API reports times as Turkey local time ("YYYY-MM-DD HH:mm:ss") without an
 * offset. Turkey has been on permanent UTC+3 since 2016, so pin it explicitly
 * rather than letting the runner's timezone decide.
 */
function toEpochMs(dateTime) {
  if (typeof dateTime !== "string") return null;
  const m = dateTime.trim().match(/^(\d{4})[-.](\d{2})[-.](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}+03:00`);
}

async function search(skip) {
  const res = await fetch(`${API_BASE}/data/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "last-istanbul-quakes (github.com/toygark/last-istanbul-quakes)",
    },
    body: JSON.stringify({
      geoNear: { lat: ISTANBUL.lat, lon: ISTANBUL.lon, radiusMeter: RADIUS_METER },
      sort: "date_-1",
      skip,
      limit: PAGE_SIZE,
    }),
  });

  if (!res.ok) {
    throw new Error(`API responded ${res.status} ${res.statusText} for skip=${skip}`);
  }

  const body = await res.json();
  if (body?.status === false) {
    throw new Error(`API reported failure: ${body?.desc ?? "unknown error"}`);
  }
  return Array.isArray(body?.result) ? body.result : [];
}

function normalise(raw) {
  const coords = raw?.geojson?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;

  // GeoJSON is [lon, lat].
  const [lon, lat] = coords.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const props = raw?.location_properties ?? {};
  const closestCity = props.closestCity ?? null;
  const epiCenter = props.epiCenter ?? null;

  const timestamp = toEpochMs(raw?.date_time ?? raw?.date);
  if (timestamp === null || Number.isNaN(timestamp)) return null;

  return {
    id: raw?.earthquake_id ?? `${timestamp}-${lat}-${lon}`,
    provider: raw?.provider ?? "unknown",
    title: (raw?.title ?? "Bilinmeyen konum").trim(),
    mag: Number(raw?.mag),
    depth: Number(raw?.depth),
    lat,
    lon,
    timestamp,
    closest_city: closestCity?.name ?? null,
    epicenter: epiCenter?.name ?? null,
    distance_km: Number(haversineKm(ISTANBUL, { lat, lon }).toFixed(1)),
    // True when the API ties the event to Istanbul province (plate code 34).
    //
    // The title has to count on its own: for offshore epicentres the API's
    // closestCity is measured to a city centre, so quakes titled "ADALAR
    // (ISTANBUL)" out in the Marmara Sea come back with closestCity Yalova.
    // props.closestCities is deliberately *not* consulted — it lists merely
    // nearby provinces, which would sweep in Cinarcik/Yalova events that have
    // nothing to do with Istanbul. Both dotted and dotless I are matched
    // because Kandilli and AFAD spell the city differently.
    is_istanbul:
      closestCity?.cityCode === ISTANBUL_CITY_CODE ||
      epiCenter?.cityCode === ISTANBUL_CITY_CODE ||
      /ISTANBUL|İSTANBUL/i.test(raw?.title ?? ""),
  };
}

async function readExistingSnapshot() {
  try {
    return JSON.parse(await readFile(OUT_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const collected = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await search(page * PAGE_SIZE);
    collected.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    // Stay comfortably inside the 40 requests/minute budget.
    if (page < MAX_PAGES - 1) await sleep(1500);
  }

  const byId = new Map();
  for (const raw of collected) {
    const quake = normalise(raw);
    if (!quake || !Number.isFinite(quake.mag)) continue;
    // The combined feed can carry the same event from both Kandilli and AFAD.
    if (!byId.has(quake.id)) byId.set(quake.id, quake);
  }

  const quakes = [...byId.values()].sort((a, b) => b.timestamp - a.timestamp);

  if (quakes.length === 0) {
    // A successful-but-empty response would otherwise wipe a good snapshot.
    const existing = await readExistingSnapshot();
    if (existing?.quakes?.length) {
      throw new Error("API returned no usable records; keeping the previous snapshot");
    }
  }

  const snapshot = {
    generated_at: new Date().toISOString(),
    source: "Kandilli Rasathanesi / AFAD — api.orhanaydogdu.com.tr",
    center: ISTANBUL,
    radius_km: RADIUS_METER / 1000,
    count: quakes.length,
    quakes,
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`Wrote ${quakes.length} quakes to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(`fetch-quakes failed: ${err.message}`);
  process.exit(1);
});
