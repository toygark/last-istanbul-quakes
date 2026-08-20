/**
 * Shared earthquake logic, imported by both the browser (assets/app.js) and the
 * fetch script (scripts/fetch-quakes.mjs).
 *
 * Kept in one place deliberately: the rule for what counts as an "Istanbul"
 * quake is subtle enough that two copies would drift apart.
 */

/** Sultanahmet, taken as the city centre for distance calculations. */
export const ISTANBUL = { lat: 41.0082, lon: 28.9784 };

export const ISTANBUL_CITY_CODE = 34;

/** Wide enough that the on-page distance filters need no new request. */
export const DEFAULT_RADIUS_METER = 250_000;

export const API_BASE = "https://api.orhanaydogdu.com.tr/deprem";

/** Great-circle distance in kilometres. */
export function haversineKm(a, b) {
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
 * The API reports times as Turkey local time ("YYYY-MM-DD HH:mm:ss") with no
 * offset. Turkey has been on permanent UTC+3 since 2016, so pin it explicitly
 * rather than letting the runner's or visitor's timezone decide.
 */
export function toEpochMs(dateTime) {
  if (typeof dateTime !== "string") return null;
  const m = dateTime.trim().match(/^(\d{4})[-.](\d{2})[-.](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}+03:00`);
}

/** Request body for POST /deprem/data/search. */
export function searchBody({ radiusMeter = DEFAULT_RADIUS_METER, skip = 0, limit = 100 } = {}) {
  return {
    geoNear: { lat: ISTANBUL.lat, lon: ISTANBUL.lon, radiusMeter },
    sort: "date_-1",
    skip,
    limit,
  };
}

/** Turn one raw API record into our flat shape, or null if unusable. */
export function normalise(raw) {
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

  const mag = Number(raw?.mag);
  if (!Number.isFinite(mag)) return null;

  return {
    id: raw?.earthquake_id ?? `${timestamp}-${lat}-${lon}`,
    provider: raw?.provider ?? "unknown",
    title: (raw?.title ?? "Bilinmeyen konum").trim(),
    mag,
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
    // props.closestCities is deliberately *not* consulted -- it lists merely
    // nearby provinces, which would sweep in Cinarcik/Yalova events that have
    // nothing to do with Istanbul. Both dotted and dotless I are matched
    // because Kandilli and AFAD spell the city differently.
    is_istanbul:
      closestCity?.cityCode === ISTANBUL_CITY_CODE ||
      epiCenter?.cityCode === ISTANBUL_CITY_CODE ||
      /ISTANBUL|İSTANBUL/i.test(raw?.title ?? ""),
  };
}

/**
 * Combine quake lists newest-first, dropping duplicates. The combined feed can
 * carry the same event from both Kandilli and AFAD; earlier lists win, so pass
 * the more trusted source first.
 */
export function mergeQuakes(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const quake of list ?? []) {
      if (quake && !byId.has(quake.id)) byId.set(quake.id, quake);
    }
  }
  return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp);
}
