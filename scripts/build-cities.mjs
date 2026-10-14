// Generate src/weather-cities.ts from data/cities.json (the source of truth).
// Run after editing the dataset:  node scripts/build-cities.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "data", "cities.json"), "utf8"));
const stops = data.stops;

const esc = (s) => JSON.stringify(s);
const rows = stops
  .map((s) => `  [${esc(s.city)}, ${s.lat}, ${s.lon}, ${esc(s.cc || "")}${s.nature ? ", 1" : ""}],`)
  .join("\n");

const out = `// ═══════════════════════════════════════════════════════════════════════════
// wh-weather-rotator · city list  (AUTO-GENERATED — do not edit by hand)
//
// Source of truth: data/cities.json  — regenerate with:
//   node scripts/build-cities.mjs
//
// ${stops.length} curated stops in display order (East -> West). Each stop carries
// an ISO-3166-1 alpha-2 country code (cc, for the flag) and a nature marker.
//
// Data: Open-Meteo (CC BY 4.0). Flags: HatScripts circle-flags (MIT).
// ═══════════════════════════════════════════════════════════════════════════

export interface WxStop {
  city: string;
  lat: number;
  lon: number;
  cc: string;        // ISO-2 country code ("" for the poles -> no flag)
  nature?: boolean;  // true => green nature marker
}

// [city, lat, lon, cc, nature?]
type Row = [string, number, number, string, number?];

const ROWS: Row[] = [
${rows}
];

export const WEATHER_STOPS: WxStop[] = ROWS.map(([city, lat, lon, cc, nature]) => ({
  city, lat, lon, cc, nature: !!nature,
}));
`;

writeFileSync(join(root, "src", "weather-cities.ts"), out);
console.log(`Generated src/weather-cities.ts (${stops.length} stops).`);
