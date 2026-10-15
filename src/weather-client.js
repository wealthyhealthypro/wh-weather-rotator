/* ═══════════════════════════════════════════════════════════════════════════
   WealthyHealthy · header Weather + AQI rotator (drop-in widget)
   Served by wh-macro at /weather.js (versioned: /weather.v1.js).

   - Self-contained, Shadow DOM (host CSS can't bleed in/out).
   - Mount selector: #hdr-wx, [data-wh-wx]
   - Fetches the cached payload ONCE from /api/weather, then rotates
     East -> West every 10s (payload order). No repeated polling.
   - On-demand any city: search box -> /api/geocode -> /api/point (pinned).
   - Data © Open-Meteo (CC BY 4.0). Flags: circle-flags (MIT).
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.WH_WX) return;

  var script = document.currentScript ||
    (function () { var s = document.getElementsByTagName("script"); return s[s.length - 1]; })();
  var BASE = "";
  try { BASE = new URL(script.src).origin; } catch (e) {}

  var HOLD = 10000;                 // 10s per stop
  var SESSION_MS = 10 * 60 * 1000;  // reuse a fetched payload for 10 min
  var SKEY = "wh-wx-cache", PKEY = "wh-wx-pins";
  var ROTATE = "\u25B8";            // small chevron
  var TREES = ["\uD83C\uDF32", "\uD83C\uDF33"]; // 🌲 🌳 (dark-green only; 🌿 washed out on light)

  // Search glyph as an inline SVG (theme-aware via currentColor) instead of the
  // platform-coloured 🔍 emoji, so it stays crisp and legible on both themes.
  var MAG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.6" cy="10.6" r="6.1" fill="none" stroke="currentColor" stroke-width="2.1"/><line x1="15.3" y1="15.3" x2="20.4" y2="20.4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

  // ── WMO weather_code -> inline SVG icon ───────────────────────────────────
  var ICON = {
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="var(--wx-i-sun)"/><g stroke="var(--wx-i-sun)" stroke-width="2" stroke-linecap="round"><line x1="12" y1="1.5" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22.5" y2="12"/><line x1="4.2" y1="4.2" x2="6" y2="6"/><line x1="18" y1="18" x2="19.8" y2="19.8"/><line x1="19.8" y1="4.2" x2="18" y2="6"/><line x1="6" y1="18" x2="4.2" y2="19.8"/></g></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z" fill="var(--wx-i-moon)"/></svg>',
    partly: '<svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="3.4" fill="var(--wx-i-sun)"/><path d="M9 19h8a3.5 3.5 0 0 0 .3-6.98A5 5 0 0 0 8 13a3 3 0 0 0 1 6z" fill="var(--wx-i-cloud)"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 0 0 .4-7.98A6 6 0 0 0 5.7 11 3.5 3.5 0 0 0 7 18z" fill="var(--wx-i-cloud)"/></svg>',
    fog: '<svg viewBox="0 0 24 24"><path d="M7 13h10a4 4 0 0 0 .4-7.98A6 6 0 0 0 5.7 6 3.5 3.5 0 0 0 7 13z" fill="var(--wx-i-cloud)"/><g stroke="var(--wx-i-cloud)" stroke-width="2" stroke-linecap="round"><line x1="5" y1="17" x2="19" y2="17"/><line x1="7" y1="20" x2="17" y2="20"/></g></svg>',
    rain: '<svg viewBox="0 0 24 24"><path d="M7 15h10a4 4 0 0 0 .4-7.98A6 6 0 0 0 5.7 8 3.5 3.5 0 0 0 7 15z" fill="var(--wx-i-cloud)"/><g stroke="var(--wx-i-rain)" stroke-width="2" stroke-linecap="round"><line x1="9" y1="18" x2="8" y2="21"/><line x1="13" y1="18" x2="12" y2="21"/><line x1="17" y1="18" x2="16" y2="21"/></g></svg>',
    snow: '<svg viewBox="0 0 24 24"><path d="M7 15h10a4 4 0 0 0 .4-7.98A6 6 0 0 0 5.7 8 3.5 3.5 0 0 0 7 15z" fill="var(--wx-i-cloud)"/><g fill="var(--wx-i-snow)"><circle cx="9" cy="19" r="1.1"/><circle cx="13" cy="20" r="1.1"/><circle cx="16" cy="19" r="1.1"/></g></svg>',
    thunder: '<svg viewBox="0 0 24 24"><path d="M7 14h10a4 4 0 0 0 .4-7.98A6 6 0 0 0 5.7 7 3.5 3.5 0 0 0 7 14z" fill="var(--wx-i-cloud)"/><path d="M12 14l-3 5h2.2l-1 4 4-6h-2.4l1.2-3z" fill="var(--wx-i-sun)"/></svg>'
  };
  function icon(code, isDay) {
    if (code == null) return "";
    if (code === 0 || code === 1) return isDay === 0 ? ICON.moon : ICON.sun;
    if (code === 2) return ICON.partly;
    if (code === 3) return ICON.cloud;
    if (code === 45 || code === 48) return ICON.fog;
    if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return ICON.snow;
    if (code >= 95) return ICON.thunder;
    if (code >= 51 && code <= 82) return ICON.rain;
    return ICON.cloud;
  }
  function tClass(t) { return t <= 0 ? "frz" : t < 16 ? "cold" : t < 30 ? "mild" : t < 40 ? "hot" : "ext"; }
  function aqiClass(a) { return a <= 50 ? "good" : a <= 100 ? "mod" : "bad"; }

  var CSS = "" +
    ":host{all:initial;display:inline-block;font-family:'IBM Plex Mono',ui-monospace,monospace;color:var(--wx-ink,#243b45);--wx-i-sun:#A9760B;--wx-i-cloud:#5B7280;--wx-i-moon:#5B7280;--wx-i-snow:#5B7280;--wx-i-rain:#2B6CB0;}" +
    ".root{display:inline-flex;align-items:center;gap:7px;opacity:0;transition:opacity .35s ease;}" +
    ".root.show{opacity:1;}" +
    ".wx{display:flex;align-items:center;gap:7px;min-height:30px;min-width:210px;white-space:nowrap;" +
      "font-size:12.5px;line-height:1;overflow:hidden;}" +
    ".f{width:15px;height:15px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 1px rgba(0,0,0,.12);}" +
    ".ic{width:19px;height:19px;flex:0 0 auto;}" +
    ".ic svg{width:100%;height:100%;display:block;}" +
    ".nat{font-size:13px;line-height:1;flex:0 0 auto;}" +
    ".city{font-weight:700;letter-spacing:.01em;color:var(--wx-ink,#1c2b33);overflow:hidden;text-overflow:ellipsis;}" +
    ".t{font-weight:700;}" +
    // Temperature colours: dark enough to clear WCAG AA (>=4.5:1) on the LIGHT
    // pages by default; the bright originals are restored under :host(.wx-dark).
    ".t.frz{color:#1E63C4;}.t.cold{color:#0A6FA8;}.t.mild{color:#127A43;}.t.hot{color:#8A6B00;}.t.ext{color:#A24E12;}" +
    ".h{color:var(--wx-soft,#5b7280);font-size:11.5px;}" +
    ".aqi{font-size:11px;font-weight:700;letter-spacing:.03em;padding:2px 7px;border-radius:10px;}" +
    ".aqi.good{background:rgba(79,217,154,.16);color:#0E7040;}" +
    ".aqi.mod{background:rgba(255,207,107,.22);color:#7E6200;}" +
    ".aqi.bad{background:rgba(255,127,102,.20);color:#A03018;}" +
    ".btn{border:0;background:none;padding:0;margin:0;cursor:pointer;color:var(--wx-soft,#5b7280);" +
      "font-size:14px;line-height:1;flex:0 0 auto;}" +
    ".btn svg{width:15px;height:15px;display:block;}" +
    ".btn:hover{color:var(--wx-ink,#1c2b33);}" +
    ".srch{position:relative;flex:0 0 auto;}" +
    ".inp{position:absolute;top:24px;left:0;z-index:5;width:210px;padding:6px 8px;font:inherit;font-size:12px;" +
      "border:1px solid var(--wx-line,#cfdae0);border-radius:8px;background:var(--wx-bg,#fff);color:inherit;" +
      "box-shadow:0 6px 18px rgba(0,0,0,.14);display:none;}" +
    ".inp.on{display:block;}" +
    ".res{position:absolute;top:56px;left:0;z-index:6;width:230px;max-height:200px;overflow:auto;" +
      "background:var(--wx-bg,#fff);border:1px solid var(--wx-line,#cfdae0);border-radius:8px;" +
      "box-shadow:0 8px 22px rgba(0,0,0,.16);display:none;}" +
    ".res.on{display:block;}" +
    ".res button{display:flex;gap:7px;align-items:center;width:100%;text-align:left;border:0;background:none;" +
      "padding:7px 9px;font:inherit;font-size:12px;cursor:pointer;color:inherit;}" +
    ".res button:hover{background:rgba(127,160,175,.14);}" +
    ".res .c{color:var(--wx-soft,#5b7280);font-size:11px;}" +
    ":host(.wx-dark){--wx-ink:#e7eef2;--wx-soft:#9fb3bd;--wx-bg:#1b2429;--wx-line:#33454e;--wx-i-sun:#ffcf6b;--wx-i-cloud:#c7d6ea;--wx-i-moon:#dfe8f5;--wx-i-snow:#e8f0fb;--wx-i-rain:#7fb3ff;}" +
    // Bright temp/AQI colours for dark pages (AA >=4.5:1 on the dark background).
    ":host(.wx-dark) .t.frz{color:var(--wx-i-rain);}:host(.wx-dark) .t.cold{color:#8fd0ff;}:host(.wx-dark) .t.mild{color:#4fd99a;}:host(.wx-dark) .t.hot{color:var(--wx-i-sun);}:host(.wx-dark) .t.ext{color:#ff7f66;}" +
    ":host(.wx-dark) .aqi.good{color:#4fd99a;}:host(.wx-dark) .aqi.mod{color:var(--wx-i-sun);}:host(.wx-dark) .aqi.bad{color:#ff7f66;}" +
    "@media (max-width:640px){.wx{min-width:0;}.city{max-width:88px;}.h{display:none;}}";

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function mount(host) {
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var style = document.createElement("style");
    style.textContent = CSS;
    var box = el("div", "wx");
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "off");
    box.title = "Weather & air quality — data by Open-Meteo (CC BY 4.0)";

    // search control
    var srch = el("div", "srch");
    var btn = el("button", "btn");
    btn.innerHTML = MAG;
    btn.type = "button";
    btn.setAttribute("aria-label", "Search a city");
    var inp = el("input", "inp");
    inp.type = "text";
    inp.placeholder = "Search a city\u2026";
    inp.setAttribute("aria-label", "Search a city for weather");
    var res = el("div", "res");
    srch.appendChild(btn); srch.appendChild(inp); srch.appendChild(res);

    var wrap = el("div", "root");
    wrap.appendChild(box);
    root.appendChild(style);
    root.appendChild(wrap);

    // Follow the HOST PAGE's theme (not the OS): the sites toggle a dark palette
    // via <html data-theme="gray">, independent of prefers-color-scheme — so an
    // OS-dark / site-light visitor must still get dark (readable) text.
    function applyTheme() {
      var dark = document.documentElement.getAttribute("data-theme") === "gray";
      if (host.classList) host.classList.toggle("wx-dark", dark);
    }
    applyTheme();
    try {
      new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    } catch (e) {}

    var pins = loadPins();
    var stops = [];
    var idx = 0;
    var timer = null;
    var searching = false;

    function setStops(list) {
      stops = list.slice();
      idx = 0;
      if (!timer && stops.length) tick();
    }

    function render(stop) {
      box.textContent = "";
      if (stop.cc) {
        var img = el("img", "f");
        img.src = BASE + "/flags/" + stop.cc + ".svg";
        img.alt = "";
        img.setAttribute("aria-hidden", "true");
        img.loading = "lazy";
        img.decoding = "async";
        box.appendChild(img);
      }
      if (stop.nature) {
        var n = el("span", "nat", TREES[Math.floor(Math.random() * TREES.length)]);
        n.setAttribute("aria-hidden", "true");
        box.appendChild(n);
      }
      var ic = el("span", "ic");
      ic.innerHTML = icon(stop.k, stop.i == null ? 1 : stop.i);
      box.appendChild(ic);
      box.appendChild(el("span", "city", stop.city));
      if (stop.T != null) box.appendChild(el("span", "t " + tClass(stop.T), Math.round(stop.T) + "\u00B0C"));
      if (stop.h != null) box.appendChild(el("span", "h", Math.round(stop.h) + "% RH"));
      if (stop.a != null) box.appendChild(el("span", "aqi " + aqiClass(stop.a), "AQI " + stop.a));
      if (!srch.parentNode) wrap.appendChild(srch);
      wrap.classList.add("show");
    }

    function tick() {
      if (!stops.length) return;
      render(stops[idx % stops.length]);
      idx++;
      clearTimeout(timer);
      timer = setTimeout(tick, HOLD);
    }

    function stopTimer() { clearTimeout(timer); timer = null; }
    function startTimer() { if (!timer && stops.length) tick(); }
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) stopTimer(); else startTimer();
    });

    // search flow
    btn.addEventListener("click", function () {
      searching = !searching;
      inp.classList.toggle("on", searching);
      if (searching) inp.focus(); else { res.classList.remove("on"); }
    });
    var geoSeq = 0;
    inp.addEventListener("input", function () {
      var q = inp.value.trim();
      if (q.length < 2) { res.classList.remove("on"); return; }
      var my = ++geoSeq;
      fetch(BASE + "/api/geocode?q=" + encodeURIComponent(q), { cache: "force-cache" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (my !== geoSeq) return;
          var hits = (j && j.results) || [];
          res.textContent = "";
          if (!hits.length) { res.classList.remove("on"); return; }
          hits.forEach(function (h) {
            var b = el("button");
            b.type = "button";
            var nm = el("span", null, h.name);
            var c = el("span", "c", h.country || h.cc || "");
            b.appendChild(nm); b.appendChild(c);
            b.addEventListener("click", function () { pick(h); });
            res.appendChild(b);
          });
          res.classList.add("on");
        })
        .catch(function () {});
    });
    function pick(hit) {
      res.classList.remove("on");
      inp.classList.remove("on");
      inp.value = "";
      searching = false;
      fetch(BASE + "/api/point?lat=" + encodeURIComponent(hit.lat) + "&lon=" + encodeURIComponent(hit.lon))
        .then(function (r) { return r.json(); })
        .then(function (r) {
          var stop = { city: hit.name, cc: (hit.cc || "").toLowerCase(), lat: hit.lat, lon: hit.lon,
            T: r.T, h: r.h, k: r.k, i: r.i, a: r.a, pinned: true };
          pins.unshift(stop);
          pins = pins.slice(0, 5);
          savePins(pins);
          setStops(pins.concat(stops.filter(function (s) { return !s.pinned; })));
          render(stop);
        })
        .catch(function () {});
    }

    // load payload (session-cached); retry if the worker is still warming up.
    // Direct Open-Meteo fetch using the VISITOR's own IP quota — the fallback
    // used when the Worker's shared Cloudflare egress IP is rate-limited (429).
    function directFetch(list) {
      var out = list.map(function (s) { return { city: s.city, cc: s.cc || "", nature: !!s.nature, lat: s.lat, lon: s.lon, T: null, h: null, k: null, i: null, a: null }; });
      function tf(url) {
        var c = new AbortController(), t = setTimeout(function () { c.abort(); }, 10000);
        return fetch(url, { signal: c.signal }).then(function (r) { clearTimeout(t); return r; }, function (e) { clearTimeout(t); throw e; });
      }
      var tasks = [];
      for (var i = 0; i < list.length; i += 25) (function (off, arr) {
        tasks.push(function () {
          var lat = arr.map(function (s) { return s.lat; }).join(",");
          var lon = arr.map(function (s) { return s.lon; }).join(",");
          return tf("https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
            "&current=temperature_2m,relative_humidity_2m,weather_code,is_day&forecast_days=1&timezone=UTC")
            .then(function (r) { return r.json(); }).then(function (j) {
              var a = Array.isArray(j) ? j : [j];
              arr.forEach(function (s, k) { var c = a[k] && a[k].current; if (c) { var o = out[off + k]; o.T = c.temperature_2m; o.h = c.relative_humidity_2m; o.k = c.weather_code; o.i = c.is_day; } });
            }).catch(function () {});
        });
      })(i, list.slice(i, i + 25));
      for (var r = 0; r < list.length; r += 100) (function (off, arr) {
        tasks.push(function () {
          var lat = arr.map(function (s) { return s.lat; }).join(",");
          var lon = arr.map(function (s) { return s.lon; }).join(",");
          return tf("https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + lat + "&longitude=" + lon + "&current=us_aqi&timezone=UTC")
            .then(function (r) { return r.json(); }).then(function (j) {
              var a = Array.isArray(j) ? j : [j];
              a.forEach(function (x, k) { if (x && x.current && x.current.us_aqi != null && out[off + k]) out[off + k].a = Math.round(x.current.us_aqi); });
            }).catch(function () {});
        });
      })(r, list.slice(r, r + 100));
      // Bounded concurrency (avoid an Open-Meteo burst 429).
      var idx = 0, LIMIT = 4;
      function next() { if (idx >= tasks.length) return Promise.resolve(); return tasks[idx++]().then(next, next); }
      var starters = [];
      for (var j = 0; j < Math.min(LIMIT, tasks.length); j++) starters.push(next());
      return Promise.all(starters).then(function () { return out; });
    }

    function apply(list) {
      var base = list || [];
      var merged;
      if (pins.length) {
        var names = {}; pins.forEach(function (s) { names[s.city] = 1; });
        merged = pins.concat(base.filter(function (s) { return !names[s.city]; }));
      } else {
        merged = base;
      }
      setStops(merged);
      return merged.length;
    }

    function load() {
      var cached = null;
      try { cached = JSON.parse(sessionStorage.getItem(SKEY) || "null"); } catch (e) {}
      var fresh = cached && cached.stops && cached.stops.length && (Date.now() - cached.at < SESSION_MS);
      if (fresh && cached.stops.some(function (s) { return s.T != null; })) { apply(cached.stops); return; }

      fetch(BASE + "/api/weather", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var stops = (j && j.stops) || [];
          if (stops.some(function (s) { return s.T != null; })) {
            try { sessionStorage.setItem(SKEY, JSON.stringify({ at: Date.now(), stops: stops })); } catch (e) {}
            apply(stops);
            return;
          }
          // Worker upstream rate-limited/empty -> fetch Open-Meteo directly.
          // Show the city list immediately; temps/AQI fill in a moment.
          if (stops.length) apply(stops);
          var listP = stops.length
            ? Promise.resolve(stops)
            : fetch(BASE + "/api/cities").then(function (r) { return r.json(); }).then(function (c) { return (c && c.stops) || []; });
          return listP.then(directFetch).then(function (full) {
            if (full.length && full.some(function (s) { return s.T != null; })) {
              try { sessionStorage.setItem(SKEY, JSON.stringify({ at: Date.now(), stops: full })); } catch (e) {}
            }
            apply(full);
            if (!full.length) setTimeout(load, 30000);
          });
        })
        .catch(function () { setTimeout(load, 30000); });
    }
    load();

    return { el: box, set: setStops, pins: pins };
  }

  function loadPins() {
    try { return JSON.parse(localStorage.getItem(PKEY) || "[]") || []; } catch (e) { return []; }
  }
  function savePins(p) {
    try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch (e) {}
  }

  function boot() {
    var hosts = document.querySelectorAll("#hdr-wx, [data-wh-wx]");
    for (var i = 0; i < hosts.length; i++) mount(hosts[i]);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.WH_WX = { mount: mount, version: "1", origin: BASE };
})();
