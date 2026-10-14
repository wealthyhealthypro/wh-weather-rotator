# ARCHITECTURE — wh-weather-rotator

How the weather + AQI rotator is put together: the data flow, the caching layers, the
HTTP contract, and how it plugs into the WealthyHealthy.Pro sites. This is the definitive
design document for the project; see `README.md` for the file map and usage.

> Status: live. Consumed by `wealthyhealthypro/wh-macro` (bitcoin + macro hosts), and
> embedded cross-origin on `jobs`, `deals` and `socials`.

## 1. Purpose

A compact, always-on **weather + air-quality rotator** for site headers. It cycles a curated
world-city list, showing a country flag, a green 🌲 on nature stops, a WMO weather icon, the
temperature, humidity and a colour-coded US-AQI pill, plus an on-demand "search any city" box.

Design goals, in priority order:

1. **Zero risk to the hosting sites' free-tier budget** — no new cron/KV/D1, no heavy work on
   the request path, tiny payloads.
2. **Minimal Open-Meteo API usage** — one central poller, batched calls, model-cadence refresh.
3. **Robustness** — never blank the UI; always fall back to last-good.
4. **Security** — XSS-safe rendering, scoped CORS, CSP-friendly delivery.

## 2. System context

```
                 Open-Meteo  (forecast API + air-quality API, free, CC BY 4.0)
                       ▲
                       │  batched HTTPS, cadence-gated
                       │
  ┌────────────────────┴────────────────────────────────────────────┐
  │  wh-macro Worker  (single central poller — this project's engine)│
  │                                                                  │
  │  scheduled() `*/5` cron ──(minute % 20 == 0)──► refreshWeather() │
  │                                                                  │
  │  src/weather.ts ─ in-memory last-good cache (+ edge Cache Rule)   │
  │        │                                                          │
  │        ├─ GET /api/weather        (CORS *, s-maxage=900)          │
  │        ├─ GET /api/geocode?q=     (CORS *, s-maxage=86400)        │
  │        ├─ GET /api/point?lat=&lon=(CORS *, s-maxage=900)          │
  │        ├─ GET /weather.js         (CORS *, + immutable .v1.js)    │
  │        └─ GET /flags/<cc>.svg     (CORS *, proxies circle-flags)  │
  └──────────────────────────────┬───────────────────────────────────┘
                                 ▼
             weather-client.js  (drop-in Shadow-DOM widget)
             mounted at  <div id="hdr-wx">  in each site's header
                                 │
   bitcoin / macro (same-origin) · jobs · deals · socials (cross-origin; CSP allowlist)
```

## 3. Components

| Part | File | Role |
|---|---|---|
| Dataset | `data/cities.json` | Curated stops (source of truth). |
| Generator | `scripts/build-cities.mjs` | `data/cities.json` → `src/weather-cities.ts`. |
| City module | `src/weather-cities.ts` | Generated `WxStop[]` + `WEATHER_STOPS`. |
| Engine | `src/weather.ts` | Fetch, cache, geocode; the poller. Runs inside a Worker. |
| Widget | `src/weather-client.js` | Shadow-DOM rotator + search UI. |

The consuming Worker (`wh-macro`) vendors the last three via `npm run sync:weather`, and wires
the routes in `src/site/index.ts`, the header mount in `src/site/render.ts`, and the CSS in
`src/site/theme.ts`.

## 4. Data model

`data/cities.json`:

```json
{ "meta": { "count": 254 }, "stops": [
  { "city": "Dubai", "lat": 25.2, "lon": 55.27, "cc": "ae", "nature": false }
] }
```

- Order is **display order, East → West** (poles → Oceania → Asia → Middle East → Europe/Africa
  → Americas). The widget renders the array as-is.
- `cc` = ISO-3166-1 alpha-2 (drives the flag; `""` = no flag, e.g. the poles).
- `nature: true` = rainforest/reef/reserve/wilderness stop (green marker).

## 5. Engine (`src/weather.ts`)

### 5.1 Fetching

- **Batched** multi-location requests (`latitude=a,b,c&longitude=…`).
- **Forecast** — `current=temperature_2m,relative_humidity_2m,weather_code,is_day` in
  **12-coord chunks**, **one retry** each (transient 503s), run with **bounded concurrency ≤ 6**
  (the Workers simultaneous-connection cap). Multi-location forecast is ~0.7 s/location
  server-side, hence the small chunks.
- **Air quality** — `current=us_aqi` in **100-coord chunks** (this endpoint is fast per-location).
- Per-request `AbortController` timeout (20 s).

### 5.2 Cadence & guards

- Forecast refreshed at most every **30 min**; AQI every **6 h** (CAMS updates every 12–24 h).
- **Daily call cap** (3000) — refresh halts and last-good is served if exceeded.
- **Last-good carry** — a new build starts from the previous reading map, so a failed chunk keeps
  the previous values instead of blanking; the cache heals across cycles.

### 5.3 Cache & request path (non-blocking)

- Module-scope `cache` holds the serialized payload + timestamp.
- `weatherCache()` — synchronous accessor for the request path (never triggers a build).
- `refreshWeather()` — build/refresh, deduped via a shared in-flight promise.
- `getWeather()` — awaiting accessor used by the cron.
- **`/api/weather`** serves `weatherCache()` immediately (or an empty payload on a cold isolate)
  and kicks `ctx.waitUntil(refreshWeather())` — a slow upstream **never** stalls a visitor.
- The `*/5` cron refreshes when `minute % 20 === 0`, keeping the cache warm.

### 5.4 Geocoding / point

- `geocode(q)` — Open-Meteo Geocoding API, `count=6`, cached in-memory per isolate (24 h, ≤300 keys).
- `pointWeather(lat, lon)` — one forecast + one AQI call for the on-demand pinned city.

## 6. HTTP contract (served by wh-macro)

| Route | Returns | Cache | CORS |
|---|---|---|---|
| `GET /api/weather` | `{ updated, stops: [{city,lat,lon,cc,nature,T,h,k,i,a}] }` | `s-maxage=900` (60 when cold) | `*` |
| `GET /api/geocode?q=` | `{ results: [{name,country,cc,lat,lon}] }` | `s-maxage=86400` | `*` |
| `GET /api/point?lat=&lon=` | `{ T,h,k,i,a }` | `s-maxage=900` | `*` |
| `GET /weather.js` | widget script | `s-maxage=300` | `*` |
| `GET /weather.v1.js` | widget script (pinned) | `immutable` (1 yr) | `*` |
| `GET /flags/<cc>.svg` | circular flag (proxied) | `s-maxage=604800` | `*` |

These are the Worker's **only CORS-enabled routes** — read-only GET, no credentials.

## 7. Widget (`src/weather-client.js`)

- IIFE; derives its API base from its own `<script src>` origin.
- **Shadow DOM** mount on `#hdr-wx` / `[data-wh-wx]` — host CSS can't bleed in/out.
- Fetches `/api/weather` **once**, caches in `sessionStorage` (10 min), then rotates **every 10 s**.
- `document.hidden` pauses rotation.
- **On-demand search** → `/api/geocode` → `/api/point` → pins the city (persisted in
  `localStorage`, max 5) at the front of the rotation.
- If the first payload is empty (cold worker), it **retries after 30 s**.
- All external strings use `textContent`; icons are inline SVG; **no emoji-font dependency** for
  the weather glyphs (the nature marker is an emoji, which renders on all platforms except it is
  intentionally decorative).

## 8. Integration (adding a surface)

1. Add `<div id="hdr-wx" aria-label="Weather and air quality"></div>` where you want it (far-left
   of the header).
2. Add `<script src="https://macro.wealthyhealthy.pro/weather.js" async></script>`.
3. Allowlist the host in CSP — `script-src … https://macro.wealthyhealthy.pro` and
   `connect-src … https://macro.wealthyhealthy.pro` (`img-src … https:`, already present on all
   WealthyHealthy sites, covers the flags).
4. Same-origin hosts (wh-macro itself) use `/weather.js` and need no CSP change.

## 9. Free-tier budget (Cloudflare Workers Free)

- **No new cron** — folds into wh-macro's existing `*/5` trigger.
- **No KV, no D1** — in-memory + Cache API/edge cache only.
- **Subrequests** — ≤ ~19 per refresh (22 forecast chunks / concurrency, 3 AQI chunks).
- **Request path** — string passthrough; protects the **10 ms** CPU cap.
- **Open-Meteo quota** — free tier = **10k calls/day** (non-commercial); batched, cadence-gated
  usage stays ~100–3,000/day.
- Add dashboard **Cache Rules** for the five routes so the CDN serves them without invoking the
  Worker (see `wh-macro` / `wh-jobs/OPS.md`).

## 10. Attribution & licensing

- Weather + AQI data: **Open-Meteo**, **CC BY 4.0** (attribution link required); air quality
  derives from **Copernicus CAMS**.
- Geocoding: **GeoNames** (CC BY 4.0), via Open-Meteo.
- Flags: **HatScripts circle-flags**, **MIT**.
- This repository's code: **MIT** (see `LICENSE`); full attributions in `NOTICE`.

## 11. Change workflow

```
edit data/cities.json
  → node scripts/build-cities.mjs        (regenerate src/weather-cities.ts)
  → commit + push this repo
  → in wh-macro: npm run sync:weather    (vendors data + engine + widget)
  → npm run typecheck → commit + push    (auto-deploys)
```
