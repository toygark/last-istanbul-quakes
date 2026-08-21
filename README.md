# last-istanbul-quakes

A small static site that lists recent earthquakes in and around **Istanbul**, using the
[Kandilli Rasathanesi API](https://github.com/orhanayd/kandilli-rasathanesi-api)
(Boğaziçi University Kandilli Observatory + AFAD data).

The site refreshes itself on three levels:

1. A **scheduled GitHub Action** runs every 10 minutes: it fetches the latest quakes, commits
   the snapshot to `data/istanbul.json`, and — in the same run — redeploys the site to Pages.
2. The **open page polls that snapshot every 60 seconds** (and immediately when a backgrounded
   tab becomes visible again), so a browser left open keeps showing current data without a reload.
3. If the snapshot is more than 10 minutes old — which happens when GitHub skips a scheduled run —
   the page **queries the API itself** and layers the fresh events on top, marking the result
   *doğrudan API'den alındı*.

## Where the data comes from

The committed snapshot is the normal source. Fetching once per scheduled run and serving the
result as a static file costs the upstream API about 6 requests/hour no matter how many people
have the page open — a courtesy worth extending to a free community service that also asks for
no more than **40 requests/minute per IP**.

That limit is per IP, so a visitor's own browser polling occasionally would never come close to
it. The snapshot is about not hammering someone else's free API for no reason, not about avoiding
a ban.

Which is why the page *does* go to the API directly when the snapshot has fallen more than
10 minutes behind — see below. That path is throttled to at most one request per browser every
5 minutes and gives up for the session after three consecutive failures, so it stays negligible
even if it runs for a while.

## Layout

```
index.html                        page markup
assets/styles.css                 styling (dark + light, responsive)
assets/app.js                     rendering, filtering, polling, live fallback
assets/theme.js                   the header's system / light / dark switch
assets/quakes.js                  shared parsing, Istanbul rule, duplicate merging (browser and script)
scripts/fetch-quakes.mjs          API client that writes the snapshot (Node 20+, no dependencies)
data/istanbul.json                the committed snapshot the page reads
.github/workflows/publish.yml     scheduled fetch, commit, and Pages deploy
```

## Setup

1. Push to `main` (scheduled workflows only run off the default branch).
2. Make sure the repo is **public**, or that the account has **GitHub Pro**. Pages is a paid
   feature on private repos, and while it is unavailable the *Source* setting below silently
   refuses to stick.
3. In **Settings → Pages**, set *Source* to **GitHub Actions**. This step has to be done by hand:
   creating a Pages site requires repo-admin rights, which `GITHUB_TOKEN` cannot be granted, so
   the deploy workflow cannot enable Pages for you. Until a Pages site exists the deploy job fails
   with *"Get Pages site failed … Not Found"*.
4. Run **Actions → Refresh data and deploy → Run workflow** once Pages is on. The schedule takes
   over from there — though note GitHub delays and sometimes drops high-frequency `schedule`
   events under load, so a 10-minute cron is a target rather than a guarantee. The page always
   shows how old its snapshot actually is, so a skipped run is visible rather than silent.

The workflow also needs **Settings → Actions → General → Read and write permissions** (the default
for most repos) so it can commit its snapshot.

### Why fetch and deploy live in one workflow

Commits made with `GITHUB_TOKEN` deliberately **do not trigger new workflow runs** — GitHub blocks
that to prevent recursive builds. So a separate deploy workflow listening on `push` would never see
the data commits, and the published site would sit frozen at whatever a human last pushed while
`data/istanbul.json` kept moving. Doing both in one run avoids that trap. The deploy job is skipped
on scheduled runs that found no new quakes, so unchanged data costs no build.

## Local development

```bash
node scripts/fetch-quakes.mjs   # refresh data/istanbul.json
python3 -m http.server 8080     # then open http://127.0.0.1:8080
```

The fetch script honours a few environment variables: `API_BASE` (default
`https://api.orhanaydogdu.com.tr/deprem`), `RADIUS_METER` (default `250000`) and `MAX_PAGES`
(default `3`, i.e. up to 300 records per run).

It exits non-zero — leaving the previous snapshot untouched — if the API errors, rate-limits, or
returns nothing usable, so a bad upstream response can never blank out the site.

## Filtering

The snapshot deliberately covers a 250 km radius around the city centre so the on-page filters can
narrow it down without another API call:

- **Sadece İstanbul** — only quakes the API ties to Istanbul province (plate code 34).
- **50 / 100 / 250 km** — great-circle distance from the city centre (41.0082, 28.9784).
- Minimum magnitude and time window filters on top of either.

Timestamps come back from the API as Turkey local time without an offset; they are pinned to
UTC+3 when parsed and displayed in `Europe/Istanbul`.

Parsing, distance and the Istanbul rule live in `assets/quakes.js`, imported by both the browser
and the fetch script — the rule is subtle enough (see the comment there) that two copies would
drift apart.

## Which feed a quake came from

The upstream API merges two feeds, and every record says which one it came from. That shows on the
row itself as a small tag next to the title — **KANDİLLİ** or **AFAD** — rather than trailing the
meta line, because the two sources routinely disagree: different magnitudes, different depths,
different wording for the same epicentre. A row that both agencies reported carries **both** tags.

The tags are outlined rather than filled, on colours (`--kandilli`, `--afad`) kept off the magnitude
ramp and off `--accent`, so a source is never read as a severity or confused with the solid YENİ
badge. An unrecognised `provider` value still gets a tag, in the muted colour, with its raw value.
Each tag's tooltip carries what *that* agency reported — magnitude, time, depth — which is the
point of keeping both on a merged row.

### One row per event

Both agencies report the same quake, so without merging every shared event took two rows. The page
folds them: `groupDuplicates()` in `assets/quakes.js` treats two reports as one event when they come
from **different** agencies, their origin times are within **15 s**, and their epicentres within
**25 km**. The row is then rendered from the preferred agency's record (Kandilli first) — one
account of the event, not an average of two — with the other agency's numbers a hover away on its
tag. In the sample snapshot that turns 300 records into 210 rows.

Both numbers are calibrated against real data rather than guessed, and the window is deliberately
tight. Kandilli and AFAD publish *origin* times, so their copies of one event land seconds apart,
while an active swarm (Marmara/Adalar, Simav) produces genuinely separate events a minute apart in
the same spot: 15 s matched 91 pairs with 2 ambiguous cases and no magnitude gap above 0.5, while
60 s added 10 more pairs, tripled the ambiguities and started pulling in neighbours. Where a report
could join more than one row, the nearest wins; two reports from the *same* agency never merge,
because that is either two events or a correction it published itself.

Three details keep the rest of the page honest:

- Merging is a **display** step. The snapshot still stores each agency's record whole, with its own
  id, magnitude and `first_seen`, so retuning the rule changes nothing about the stored data.
- A merged row's `first_seen` is the **earliest** of its parts, so the second agency's copy landing
  an hour later cannot re-flag a row as YENİ.
- Filters and the count in the status line run on merged rows, and a row counts as Istanbul if
  *either* agency ties it there.

## New in the latest refresh

Quakes the most recent refresh added are marked **YENİ** and counted in the status line. The
badge belongs to the data, not to the reader: everyone sees the same marks, reloading changes
nothing, and the next refresh ten minutes later retires them.

What makes that possible is a stamp, not the quake's own time. Kandilli and AFAD publish some
events minutes after they happen — a batch of hour-old records landing at once is exactly what
the badge is for — so `scripts/fetch-quakes.mjs` stamps every quake with a `first_seen`: the
`generated_at` of the snapshot that introduced it, carried forward on later runs. It also records
the previous run's time as `previous_generated_at`. A quake is new when its stamp equals the
generation on screen, which is all the page has to check.

Two details keep it honest:

- The live fallback stamps what it introduces the same way, using the fetch time, and caches the
  stamped copies — so during a slipped schedule the badge still means what it says, and a reload
  rebuilds the same marks.
- Quakes a snapshot carried before this field existed have no stamp and never match, so the first
  run after deploying it flags nothing for anyone rather than lighting up the whole list.

### Cache busting

GitHub Pages serves everything with `Cache-Control: max-age=600`, and it caches `index.html` and
the assets *independently* — so without care a reload can pair new HTML with ten-minute-old JS.
The asset URLs therefore carry a `?v=N`: **bump it in `index.html` (the stylesheet and both scripts)
and in the `./quakes.js?v=` import inside `app.js` whenever those files change.** The snapshot JSON needs no
version, it is fetched with a timestamp query and `cache: "no-store"`.

### Coming back to a page the browser put away

iOS Safari does not keep a backgrounded tab alive: it paints the last frame it had, then hands
the restored page back — often as a fresh session with `sessionStorage` emptied. Two things follow
from that, and the page handles both:

- The live results are cached in **`localStorage`**, not `sessionStorage`. Otherwise a discarded
  tab loses them, re-renders the older snapshot, and visibly jumps when the live fetch lands —
  every time the app comes to the foreground. A desktop tab keeps its session alive and so never
  showed this.
- `visibilitychange` **and** `pageshow` both trigger a refresh, and it re-renders before the
  network call rather than after, so the "x dakika önce" labels frozen into the restored frame are
  corrected immediately and the status says a refresh is under way.

The API throttle is stored the same way, so returning to the app repeatedly costs the upstream API
one request per five minutes rather than one per switch.

### When the schedule slips

GitHub `schedule` events are best-effort: in practice this repo has seen slots skipped entirely
and others fire five minutes late. Nothing hides that — the page always states how old its data
is, and the live fallback covers the gap when a run goes missing. If the API cannot be reached
from the browser (no CORS headers for the origin, or the visitor is offline), the page keeps
showing the snapshot with its true age rather than failing.

## Theme switch

The header carries a three-state switch: **Sistem** (the default, follows the device), **Açık** and
**Koyu**, cycled by clicking and remembered in `localStorage`. Three states rather than two so a
reader who pins one can get back to following the device.

Pinning writes `data-theme` on `<html>`; the palette lives entirely in `assets/styles.css`, so
`assets/theme.js` never mentions a colour. The light palette appears twice there —
`@media (prefers-color-scheme: light) :root:not([data-theme="dark"])` and `:root[data-theme="light"]`
— because CSS cannot express "system says light *and* the reader has not overridden it" outside a
media query. **Keep the two blocks identical.** The `:not()` is what lets someone on a light phone
pin dark. `color-scheme` is set per state as well, so scrollbars and form controls follow.

The stored choice is applied by a small inline script in `index.html`, not by `theme.js`: module
scripts are deferred, and a deferred script paints the wrong theme and then corrects it — exactly
the flash the inline script avoids.

## Data and attribution

Data belongs to Boğaziçi University Kandilli Observatory and Earthquake Research Institute and to
AFAD, served through Orhan Aydoğdu's [Kandilli Rasathanesi API](https://github.com/orhanayd/kandilli-rasathanesi-api).
That API is free for personal, educational and research use and **requires attribution**; commercial
use needs written permission from the observatory. This site is unofficial and informational only —
follow AFAD's official channels in an emergency.
