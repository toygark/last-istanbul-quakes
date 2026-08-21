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

/** Providers in preference order; the first one present supplies the row. */
export const PROVIDER_ORDER = ["kandilli", "afad"];

/**
 * How close two agencies' reports have to be to count as the same event.
 *
 * Both numbers are calibrated against a real snapshot, not guessed. Kandilli
 * and AFAD publish *origin* times, not publish times, so their copies of one
 * event land within a couple of seconds of each other and a few kilometres
 * apart -- while an active swarm (Marmara/Adalar, Simav) produces genuinely
 * separate events a minute apart in the same spot. Widening the window past
 * ~15s starts swallowing those neighbours: in the sample, 15s matched 91 pairs
 * with 2 ambiguous cases and no magnitude gap above 0.5, and 60s added only 10
 * more pairs while tripling the ambiguities and pulling in a 1.0 gap.
 */
export const DUPLICATE_WINDOW_MS = 15_000;
export const DUPLICATE_RADIUS_KM = 25;

function providerRank(provider) {
  const i = PROVIDER_ORDER.indexOf(provider);
  return i === -1 ? PROVIDER_ORDER.length : i;
}

/**
 * The stamp for a merged row: the earliest of its parts, so a row is only ever
 * "new" the refresh it first appeared in. The second agency's copy arriving an
 * hour later must not re-flag a row the reader has already seen.
 *
 * A part with no stamp (it predates the field) makes the whole row unstamped,
 * which is the same "not news" answer for the same reason.
 */
function earliestStamp(members) {
  let earliest = null;
  for (const m of members) {
    if (!m.first_seen) return null;
    if (earliest === null || Date.parse(m.first_seen) < Date.parse(earliest)) earliest = m.first_seen;
  }
  return earliest;
}

/**
 * Collapse the same event reported by both agencies into one row, carrying
 * every source with it as `sources` so the page can still tag them.
 *
 * Deliberately a *display* step: the snapshot keeps both agencies' records
 * whole, with their own ids, magnitudes and first_seen stamps. Only what the
 * reader sees is merged, so nothing about the stored data has to be undone if
 * the rule below is ever retuned.
 *
 * One member per provider: two rows from the *same* agency seconds apart are
 * two events (or a correction it published itself), not a duplicate to hide.
 * Where a report could join more than one row, the nearest one wins.
 */
export function groupDuplicates(
  quakes,
  { windowMs = DUPLICATE_WINDOW_MS, radiusKm = DUPLICATE_RADIUS_KM } = {},
) {
  const sorted = [...(quakes ?? [])].sort((a, b) => b.timestamp - a.timestamp);
  const groups = [];

  for (const quake of sorted) {
    let best = null;
    // Groups were created newest-first, so the candidates within the window
    // are the ones at the end of the list; stop as soon as we walk past it.
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const group = groups[i];
      const gap = group.timestamp - quake.timestamp;
      if (gap > windowMs) break;
      if (group.members.some((m) => m.provider === quake.provider)) continue;
      const km = haversineKm(group, quake);
      if (km > radiusKm) continue;
      if (!best || km < best.km || (km === best.km && gap < best.gap)) best = { group, km, gap };
    }

    if (best) best.group.members.push(quake);
    else groups.push({ lat: quake.lat, lon: quake.lon, timestamp: quake.timestamp, members: [quake] });
  }

  return groups
    .map(({ members }) => {
      const ordered = [...members].sort((a, b) => providerRank(a.provider) - providerRank(b.provider));
      const [primary] = ordered;
      return {
        // The preferred agency's record supplies the row: title, position,
        // depth, magnitude and time all stay one agency's account of the event
        // rather than an average of two.
        ...primary,
        // Either agency tying the event to Istanbul is enough -- they word
        // offshore epicentres differently ("ADALAR (ISTANBUL)" vs "Marmara
        // Denizi - [09.63 km] Adalar (Istanbul)").
        is_istanbul: ordered.some((m) => m.is_istanbul),
        first_seen: earliestStamp(ordered),
        sources: ordered.map((m) => ({
          provider: m.provider,
          id: m.id,
          mag: m.mag,
          depth: m.depth,
          timestamp: m.timestamp,
        })),
      };
    })
    .sort((a, b) => b.timestamp - a.timestamp);
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
