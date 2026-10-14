# wh-weather-rotator

A small, self-contained **weather + air-quality rotator** for website headers: a curated
world-city dataset, a Cloudflare-Worker data engine, and a drop-in Shadow-DOM widget that
cycles cities **East → West**, showing a country flag, a green 🌲 on nature/rainforest stops,
a weather icon, the temperature, humidity and a colour-coded US-AQI pill.

It powers the header rotator on the WealthyHealthy.Pro family of sites
(`bitcoin`/`macro`, `jobs`, `deals`, `socials`).

> This repository is the **source of truth**. The consuming site (`wh-macro`, GitHub
> `wealthyhealthypro/wh-macro`) vendors the generated files via its `npm run sync:weather`
> script — do not hand-edit the copies there.

## Contents

```
data/cities.json        the curated stop list (source of truth)
scripts/build-cities.mjs generates src/weather-cities.ts from data/cities.json
src/weather-cities.ts   generated TS module (WxStop[] + WEATHER_STOPS)
src/weather.ts          the Worker-side data engine (single central poller)
src/weather-client.js   the drop-in Shadow-DOM widget (served as /weather.js)
```

## Dataset

`data/cities.json` — ~254 curated stops. Each entry:

```json
{ "city": "Dubai", "lat": 25.2, "lon": 55.27, "cc": "ae", "nature": false }
```

- **Order** is display order (**East → West**): poles → Oceania → Asia → Middle East →
  Europe/Africa → Americas.
- `cc` is an ISO-3166-1 alpha-2 country code (drives the flag; `""` for the poles).
- `nature: true` marks rainforests / reefs / reserves / wilderness stops (green 🌲 marker).
- Coordinates are approximate city centres (~2 dp) — the model grid is ~11 km, so that
  precision is more than sufficient.

Regenerate the TypeScript from the dataset after editing it:

```bash
node scripts/build-cities.mjs
```

## Data engine (`src/weather.ts`)

Designed to stay well inside Cloudflare Workers' **free tier** and Open-Meteo's free quota:

- **Single central poller** — all stops batched into a few Open-Meteo calls (forecast in
  **12-coord chunks** with one retry each, run with **bounded concurrency ≤ 6**; air quality in
  **100-coord chunks**). Multi-location *forecast* is ~0.7 s per location server-side, hence
  the small chunks.
- **Cadence** — forecast refreshed at most every **30 min**, AQI every **6 h**.
- **Guards** — a hard **daily call cap**, exponential-ish last-good fallback, and an in-memory
  cache; the request path is **non-blocking** (serves cache and refreshes in the background).
- **Endpoints** (implemented by the consuming Worker, not by this repo's code alone):
  `GET /api/weather`, `GET /api/geocode?q=`, `GET /api/point?lat=&lon=`.

## Widget (`src/weather-client.js`)

- Self-contained IIFE + **Shadow DOM** (host CSS can't bleed in/out).
- Mount selector: `#hdr-wx`, `[data-wh-wx]`.
- Fetches the payload once, then rotates **East → West** every 10 s; `document.hidden` pauses.
- On-demand any-city search → geocode → pin (persisted in `localStorage`).
- All external strings rendered via `textContent` (XSS-safe).
- Served cross-origin; consuming sites allowlist the host in CSP `script-src` + `connect-src`.

## Attribution (required)

- **Weather and air-quality data:** [Open-Meteo](https://open-meteo.com/) — data under
  **CC BY 4.0**. Include an attribution link wherever the data is shown
  ("Weather data by Open-Meteo.com").
- **Country flags:** [HatScripts/circle-flags](https://github.com/HatScripts/circle-flags) (**MIT**).
- Air-quality data derives from the **Copernicus CAMS** programme (attribution to CAMS/ECMWF).
- Location data (geocoding) is based on **GeoNames**.

## Usage

Consuming Worker fetches the files via `npm run sync:weather` (implemented in the site repo),
or copy `src/weather.ts` + `src/weather-cities.ts` + `src/weather-client.js` into the Worker's
`src/site/` and wire the routes/header mount.

## Licence

- **Code** (this repository): **MIT** — see [`LICENSE`](LICENSE).
- **Data** (weather/AQI): Open-Meteo, **CC BY 4.0**.
- **Flags**: circle-flags, **MIT**.

See [`NOTICE`](NOTICE) for the full attribution list.
