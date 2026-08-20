#!/usr/bin/env node
/**
 * Fetches recent earthquakes around Istanbul from the Kandilli Rasathanesi API
 * (https://github.com/orhanayd/kandilli-rasathanesi-api) and writes a snapshot
 * to data/istanbul.json, which the site reads.
 *
 * Parsing and the Istanbul-tagging rule live in assets/quakes.js, shared with
 * the browser so the two can never disagree.
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  API_BASE as DEFAULT_API_BASE,
  DEFAULT_RADIUS_METER,
  ISTANBUL,
  mergeQuakes,
  normalise,
  searchBody,
} from "../assets/quakes.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = resolve(ROOT, "data/istanbul.json");

const API_BASE = process.env.API_BASE ?? DEFAULT_API_BASE;
const RADIUS_METER = Number(process.env.RADIUS_METER ?? DEFAULT_RADIUS_METER);
const PAGE_SIZE = 100; // API hard-caps limit at 100
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(skip) {
  const res = await fetch(`${API_BASE}/data/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "last-istanbul-quakes (github.com/toygark/last-istanbul-quakes)",
    },
    body: JSON.stringify(searchBody({ radiusMeter: RADIUS_METER, skip, limit: PAGE_SIZE })),
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

async function readExistingSnapshot() {
  try {
    return JSON.parse(await readFile(OUT_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Stamp every quake with the snapshot generation that first carried it, so the
 * page can point at what the latest refresh actually added -- something the
 * quake's own timestamp cannot tell you, because Kandilli and AFAD publish
 * events minutes after they happen.
 *
 * Quakes already in the previous snapshot keep their stamp. Ones the previous
 * snapshot carried without a stamp (it predates this field) are dated to that
 * snapshot rather than to now: they were already on screen, so they are not
 * news, and without this the first run of this version would flag the entire
 * list for every reader.
 */
function stampFirstSeen(quakes, previous, generatedAt) {
  const previousAt = previous?.generated_at ?? null;
  const known = new Map(
    (previous?.quakes ?? []).map((q) => [q.id, q.first_seen ?? previousAt ?? generatedAt]),
  );
  return quakes.map((q) => ({ ...q, first_seen: known.get(q.id) ?? generatedAt }));
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

  const quakes = mergeQuakes(collected.map(normalise).filter(Boolean));
  const previous = await readExistingSnapshot();

  if (quakes.length === 0) {
    // A successful-but-empty response would otherwise wipe a good snapshot.
    if (previous?.quakes?.length) {
      throw new Error("API returned no usable records; keeping the previous snapshot");
    }
  }

  const generatedAt = new Date().toISOString();
  const snapshot = {
    generated_at: generatedAt,
    previous_generated_at: previous?.generated_at ?? null,
    source: "Kandilli Rasathanesi / AFAD — api.orhanaydogdu.com.tr",
    center: ISTANBUL,
    radius_km: RADIUS_METER / 1000,
    count: quakes.length,
    quakes: stampFirstSeen(quakes, previous, generatedAt),
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`Wrote ${quakes.length} quakes to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(`fetch-quakes failed: ${err.message}`);
  process.exit(1);
});
