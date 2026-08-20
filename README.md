# last-istanbul-quakes

A small static site that lists recent earthquakes in and around **Istanbul**, using the
[Kandilli Rasathanesi API](https://github.com/orhanayd/kandilli-rasathanesi-api)
(Boğaziçi University Kandilli Observatory + AFAD data).

The site refreshes itself on two levels:

1. A **scheduled GitHub Action** runs every 10 minutes: it fetches the latest quakes, commits
   the snapshot to `data/istanbul.json`, and — in the same run — redeploys the site to Pages.
2. The **open page polls that snapshot every 60 seconds** (and immediately when a backgrounded
   tab becomes visible again), so a browser left open keeps showing current data without a reload.

## Why a committed snapshot instead of calling the API from the browser?

The upstream API allows **40 requests/minute per IP** and **auto-bans offenders for 72 hours**.
If every visitor's browser polled it directly, a modest traffic spike would get the API — or the
visitors — banned. Fetching once per cron run and serving the result as a static file keeps usage
at roughly 6 requests/hour regardless of how many people have the page open.

## Layout

```
index.html                        page markup
assets/styles.css                 styling (dark + light, responsive)
assets/app.js                     rendering, filtering, polling
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

## Data and attribution

Data belongs to Boğaziçi University Kandilli Observatory and Earthquake Research Institute and to
AFAD, served through Orhan Aydoğdu's [Kandilli Rasathanesi API](https://github.com/orhanayd/kandilli-rasathanesi-api).
That API is free for personal, educational and research use and **requires attribution**; commercial
use needs written permission from the observatory. This site is unofficial and informational only —
follow AFAD's official channels in an emergency.
