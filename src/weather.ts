// ═══════════════════════════════════════════════════════════════════════════
// wh-macro · Weather + AQI engine (server-side, cached)
//
// ONE central poller for every WealthyHealthy surface. It batches all rotator
// stops into a few comma-separated Open-Meteo calls, caches the result, and
// serves it from `/api/weather` as a pre-serialized string — so the page path
// does NO upstream fetch and NO heavy parsing (protects the 10 ms free CPU cap).
//
// Quota discipline (Open-Meteo free tier = 10k calls/day, non-commercial):
//   · forecast refreshed at most every REFRESH_MS (30 min) — models update every
//     few hours, so this is already generous;
//   · AQI refreshed every AQI_MS (6 h) — CAMS updates every 12–24 h;
//   · a hard daily call cap (MAX_CALLS) + last-good fallback;
//   · refresh is driven by the existing `*/5` cron (no new trigger, no KV/D1).
//
// Data © Open-Meteo (CC BY 4.0) — attribution is required wherever shown.
// ═══════════════════════════════════════════════════════════════════════════

import type { WxStop } from "./weather-cities";
import { WEATHER_STOPS } from "./weather-cities";

export interface Reading {
  T: number | null;  // temperature_2m (°C)
  h: number | null;  // relative_humidity_2m (%)
  k: number | null;  // weather_code (WMO)
  i: number | null;  // is_day (1/0)
  a: number | null;  // us_aqi
}

export interface StopOut extends WxStop, Reading {}

const FCST = "https://api.open-meteo.com/v1/forecast";
const AIR = "https://air-quality-api.open-meteo.com/v1/air-quality";
const GEO = "https://geocoding-api.open-meteo.com/v1/search";

const REFRESH_MS = 30 * 60 * 1000;      // forecast cadence
const AQI_MS = 6 * 60 * 60 * 1000;      // air-quality cadence
const FC_CHUNK = 12;                     // forecast coords/request (multi-location is
                                         // ~0.7s/location server-side -> keep chunks small)
const AQI_CHUNK = 100;                   // air-quality coords/request (fast per-location)
const CONCURRENCY = 6;                   // max simultaneous subrequests (Workers cap = 6)
const MAX_CALLS_PER_DAY = 3000;          // hard quota guard (10k/day cap)
const TIMEOUT_MS = 20000;

// ── module-scope state (per isolate; the Cache API / edge cache is the shared tier)
let cache: { at: number; body: string } | null = null;
let inflight: Promise<string> | null = null;
let lastByCity: Record<string, Reading> = {};
let lastAqiAt = 0;
let callsDay = "";
let callsToday = 0;

function bumpCall(): boolean {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== callsDay) { callsDay = day; callsToday = 0; }
  if (callsToday >= MAX_CALLS_PER_DAY) return false;
  callsToday++;
  return true;
}

async function getJson(url: string, attempts = 2): Promise<unknown> {
  let last: unknown;
  for (let a = 0; a < attempts; a++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      last = e;
      if (a < attempts - 1) await new Promise((res) => setTimeout(res, 1200)); // transient 503/slow
    } finally { clearTimeout(t); }
  }
  throw last;
}

const empty = (): Reading => ({ T: null, h: null, k: null, i: null, a: null });

// Run async tasks over a list with a bounded number of simultaneous subrequests
// (Workers allow at most 6 open connections per invocation).
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Batched current-conditions fetch. Multi-location forecast is slow per location,
// so small chunks are run with bounded concurrency. A failed chunk leaves the
// carried-over (last-good) values in place — never throws.
async function fetchForecast(stops: WxStop[], out: Record<string, Reading>): Promise<void> {
  await runPool(chunks(stops, FC_CHUNK), CONCURRENCY, async (chunk) => {
    if (!bumpCall()) return;
    const lat = chunk.map((s) => s.lat).join(",");
    const lon = chunk.map((s) => s.lon).join(",");
    try {
      const j = (await getJson(
        `${FCST}?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,relative_humidity_2m,weather_code,is_day` +
        `&forecast_days=1&timezone=UTC`,
      )) as any;
      const arr = Array.isArray(j) ? j : [j];
      chunk.forEach((s, k) => {
        const c = arr[k]?.current;
        if (!c) return;
        const cur = out[s.city] ?? empty();
        out[s.city] = {
          T: c.temperature_2m ?? cur.T,
          h: c.relative_humidity_2m ?? cur.h,
          k: c.weather_code ?? cur.k,
          i: c.is_day ?? cur.i,
          a: cur.a,
        };
      });
    } catch { /* keep last-good for this chunk */ }
  });
}

// Batched air-quality fetch; only called on the AQI cadence.
async function fetchAqi(stops: WxStop[], out: Record<string, Reading>): Promise<void> {
  await runPool(chunks(stops, AQI_CHUNK), CONCURRENCY, async (chunk) => {
    if (!bumpCall()) return;
    const lat = chunk.map((s) => s.lat).join(",");
    const lon = chunk.map((s) => s.lon).join(",");
    try {
      const j = (await getJson(
        `${AIR}?latitude=${lat}&longitude=${lon}&current=us_aqi&timezone=UTC`,
      )) as any;
      const arr = Array.isArray(j) ? j : [j];
      chunk.forEach((s, k) => {
        const a = arr[k]?.current?.us_aqi;
        if (a == null) return;
        const cur = out[s.city] ?? empty();
        cur.a = Math.round(a);
        out[s.city] = cur;
      });
    } catch { /* keep last-good AQI */ }
  });
}

async function refresh(now: number): Promise<string> {
  const out: Record<string, Reading> = { ...lastByCity };
  await fetchForecast(WEATHER_STOPS, out);
  const withAqi = now - lastAqiAt >= AQI_MS;
  if (withAqi) {
    await fetchAqi(WEATHER_STOPS, out);
    lastAqiAt = now;
  }
  lastByCity = out;
  const stops: StopOut[] = WEATHER_STOPS.map((s) => ({ ...s, ...(out[s.city] ?? empty()) }));
  return JSON.stringify({ updated: new Date(now).toISOString(), stops });
}

// Cache accessor for the request path — synchronous; never triggers a build.
export function weatherCache(): { body: string; fresh: boolean } | null {
  return cache ? { body: cache.body, fresh: Date.now() - cache.at < REFRESH_MS } : null;
}

// Build/refresh the payload; dedupes concurrent callers via `inflight`. The cron
// uses this to keep the cache warm; the request path calls it in the background.
export function refreshWeather(): Promise<string> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const body = await refresh(Date.now());
      cache = { at: Date.now(), body };
      return body;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// Awaiting accessor (cron): fresh cache, else rebuild; on failure falls back to
// last-good, or an empty payload so the widget simply stays hidden.
export async function getWeather(): Promise<string> {
  const c = weatherCache();
  if (c && c.fresh) return c.body;
  try {
    return await refreshWeather();
  } catch {
    return c ? c.body : '{"updated":null,"stops":[]}';
  }
}

// On-demand single-point reading (used by the widget's "search a city" flow).
export async function pointWeather(lat: number, lon: number): Promise<Reading> {
  const out = empty();
  if (!bumpCall()) return out;
  try {
    const j = (await getJson(
      `${FCST}?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,weather_code,is_day` +
      `&forecast_days=1&timezone=UTC`,
    )) as any;
    const c = j?.current;
    if (c) { out.T = c.temperature_2m ?? null; out.h = c.relative_humidity_2m ?? null; out.k = c.weather_code ?? null; out.i = c.is_day ?? null; }
  } catch { /* leave nulls */ }
  if (bumpCall()) {
    try {
      const j = (await getJson(`${AIR}?latitude=${lat}&longitude=${lon}&current=us_aqi&timezone=UTC`)) as any;
      const a = j?.current?.us_aqi;
      if (a != null) out.a = Math.round(a);
    } catch { /* no AQI */ }
  }
  return out;
}

// ── Geocoding (on-demand place search; cached in-memory per isolate) ─────────
export interface GeoHit { name: string; country: string; cc: string; lat: number; lon: number; }

const geoCache = new Map<string, { at: number; hits: GeoHit[] }>();
const GEO_TTL = 24 * 60 * 60 * 1000;
const GEO_MAX = 300;

export async function geocode(q: string): Promise<GeoHit[]> {
  const key = q.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
  if (key.length < 2) return [];
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < GEO_TTL) return hit.hits;
  try {
    const j = (await getJson(`${GEO}?name=${encodeURIComponent(key)}&count=6&language=en`)) as any;
    const hits: GeoHit[] = Array.isArray(j?.results)
      ? j.results.map((r: any) => ({
          name: r.name, country: r.country ?? "", cc: (r.country_code ?? "").toLowerCase(),
          lat: r.latitude, lon: r.longitude,
        }))
      : [];
    if (geoCache.size >= GEO_MAX) geoCache.delete(geoCache.keys().next().value as string);
    geoCache.set(key, { at: Date.now(), hits });
    return hits;
  } catch {
    return hit?.hits ?? [];
  }
}
