// Weather for the dashboard, fetched here (not in the browser) so it also works on
// networks that block the weather service.
// Main source: Open-Meteo (free, no key). Backup: MET Norway (free, no key, worldwide),
// used when Open-Meteo turns the request away (it sometimes blocks shared cloud servers).
// GET /api/weather?lat=21.28&lon=-157.75&tz=Pacific/Honolulu -> current, hourly and daily forecast
// GET /api/weather?q=Tokyo                                    -> place search for adding a location
const UA = "SombrioOhanaDashboard/1.0 (family dashboard; my-dashboard-azp.pages.dev)";

function json(body, status = 200, cache = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": cache ? "private, max-age=" + cache : "no-store" },
  });
}

async function openMeteo(lat, lon) {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat.toFixed(2) + "&longitude=" + lon.toFixed(2) +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day" +
    "&hourly=temperature_2m,precipitation_probability,weather_code,is_day" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,wind_speed_10m_max" +
    "&timezone=auto&forecast_days=7&temperature_unit=fahrenheit&wind_speed_unit=mph";
  const r = await fetch(url, { headers: { "User-Agent": UA }, cf: { cacheTtl: 600, cacheEverything: true } });
  if (!r.ok) throw new Error("Open-Meteo " + r.status);
  const j = await r.json();
  if (!j.current || !j.daily || !j.hourly) throw new Error("Open-Meteo bad data");
  j.source = "Open-Meteo";
  return j;
}

// ---------- MET Norway backup, reshaped to look like Open-Meteo's answer ----------
const SYM = {
  clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 45,
  lightrainshowers: 80, rainshowers: 81, heavyrainshowers: 82,
  lightrain: 61, rain: 63, heavyrain: 65,
  lightsleet: 66, sleet: 67, heavysleet: 67, lightsleetshowers: 66, sleetshowers: 67, heavysleetshowers: 67,
  lightsnow: 71, snow: 73, heavysnow: 75, lightsnowshowers: 85, snowshowers: 86, heavysnowshowers: 86,
};
function symCode(s) {
  const base = String(s || "").replace(/_(day|night|polartwilight)$/, "");
  if (/thunder/.test(base)) return 95;
  return SYM[base] != null ? SYM[base] : 3;
}
const isDay = (s) => (/_night$/.test(String(s || "")) ? 0 : 1);
const toF = (c) => Math.round((c * 9) / 5 + 32);
const toMph = (ms) => Math.round(ms * 2.23694);

// Local "YYYY-MM-DDTHH:MM" for a time, in a named time zone or a fixed offset (hours).
function localStamp(ms, tz, off) {
  if (tz) {
    try {
      const o = {};
      for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) o[p.type] = p.value;
      return o.year + "-" + o.month + "-" + o.day + "T" + o.hour + ":" + o.minute;
    } catch (e) { /* bad zone name: fall through to the offset */ }
  }
  return new Date(ms + off * 3600000).toISOString().slice(0, 16);
}

// Sunrise or sunset (UTC ms) for a calendar date, NOAA method.
function sunUTC(y, m, d, lat, lon, rising) {
  const rad = Math.PI / 180, N = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 864e5), lh = lon / 15, t = N + ((rising ? 6 : 18) - lh) / 24;
  const M = 0.9856 * t - 3.289, L = (M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634 + 720) % 360;
  let RA = (Math.atan(0.91764 * Math.tan(L * rad)) / rad + 720) % 360;
  RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
  const sd = 0.39782 * Math.sin(L * rad), cd = Math.cos(Math.asin(sd));
  const cH = (Math.cos(90.833 * rad) - sd * Math.sin(lat * rad)) / (cd * Math.cos(lat * rad));
  if (cH > 1 || cH < -1) return null;
  const H = (rising ? 360 - Math.acos(cH) / rad : Math.acos(cH) / rad) / 15;
  const UT = (((H + RA - 0.06571 * t - 6.622 - lh) % 24) + 24) % 24;
  return Date.UTC(y, m - 1, d) + UT * 3600000;
}

async function metNorway(lat, lon, tz) {
  const r = await fetch("https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=" + lat.toFixed(2) + "&lon=" + lon.toFixed(2),
    { headers: { "User-Agent": UA }, cf: { cacheTtl: 600, cacheEverything: true } });
  if (!r.ok) throw new Error("MET Norway " + r.status);
  const ts = ((await r.json()).properties || {}).timeseries || [];
  if (!ts.length) throw new Error("MET Norway bad data");
  const off = Math.round(lon / 15);
  const sym = (e) => { const d = e.data || {}; return ((d.next_1_hours || d.next_6_hours || d.next_12_hours || {}).summary || {}).symbol_code; };

  const now = Date.now();
  let first = ts.findIndex((e) => Date.parse(e.time) > now - 3600000);
  if (first < 0) first = 0;
  const c = ts[first], cd = c.data.instant.details;
  const current = {
    time: localStamp(Date.parse(c.time), tz, off),
    temperature_2m: toF(cd.air_temperature), apparent_temperature: toF(cd.air_temperature),
    relative_humidity_2m: Math.round(cd.relative_humidity || 0), wind_speed_10m: toMph(cd.wind_speed || 0),
    weather_code: symCode(sym(c)), is_day: isDay(sym(c)),
  };

  const hourly = { time: [], temperature_2m: [], precipitation_probability: [], weather_code: [], is_day: [] };
  const days = {};
  for (let i = first; i < ts.length; i++) {
    const e = ts[i], ms = Date.parse(e.time), st = localStamp(ms, tz, off), det = e.data.instant.details, s = sym(e);
    hourly.time.push(st); hourly.temperature_2m.push(toF(det.air_temperature)); hourly.precipitation_probability.push(null);
    hourly.weather_code.push(symCode(s)); hourly.is_day.push(isDay(s));
    const day = st.slice(0, 10), hr = +st.slice(11, 13);
    const D = days[day] || (days[day] = { lo: Infinity, hi: -Infinity, wind: 0, code: null, noon: 99, worst: 0 });
    const six = (e.data.next_6_hours || {}).details || {};
    D.lo = Math.min(D.lo, det.air_temperature, six.air_temperature_min != null ? six.air_temperature_min : Infinity);
    D.hi = Math.max(D.hi, det.air_temperature, six.air_temperature_max != null ? six.air_temperature_max : -Infinity);
    D.wind = Math.max(D.wind, det.wind_speed || 0);
    if (s && hr >= 6 && hr <= 18) D.worst = Math.max(D.worst, symCode(s) >= 51 ? symCode(s) : 0);
    if (s && Math.abs(hr - 12) < D.noon) { D.noon = Math.abs(hr - 12); D.code = symCode(s); }
  }
  const daily = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_probability_max: [], sunrise: [], sunset: [], wind_speed_10m_max: [] };
  for (const day of Object.keys(days).sort().slice(0, 7)) {
    const D = days[day], [y, m, d] = day.split("-").map(Number);
    // Sun times: try the calendar date and its neighbours in UTC, keep the one that lands on this local date.
    const pick = (rising) => {
      for (const k of [0, 1, -1]) { const u = sunUTC(y, m, d + k, lat, lon, rising); if (u && localStamp(u, tz, off).slice(0, 10) === day) return localStamp(u, tz, off); }
      return day + (rising ? "T06:00" : "T18:00");
    };
    daily.time.push(day);
    daily.weather_code.push(D.worst || (D.code != null ? D.code : 3));
    daily.temperature_2m_max.push(toF(D.hi)); daily.temperature_2m_min.push(toF(D.lo));
    daily.precipitation_probability_max.push(null);
    daily.sunrise.push(pick(true)); daily.sunset.push(pick(false));
    daily.wind_speed_10m_max.push(toMph(D.wind));
  }
  return { source: "MET Norway", current, hourly, daily };
}

async function placeSearch(q) {
  try {
    const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=" + encodeURIComponent(q), { headers: { "User-Agent": UA }, cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!r.ok) throw new Error("geo " + r.status);
    const j = await r.json();
    return (j.results || []).map((p) => ({
      name: p.name, region: [p.admin1, p.country].filter(Boolean).join(", "), tz: p.timezone || "",
      lat: Math.round(p.latitude * 100) / 100, lon: Math.round(p.longitude * 100) / 100,
    }));
  } catch (e) {
    // Backup: OpenStreetMap's place search.
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&q=" + encodeURIComponent(q), { headers: { "User-Agent": UA, "Accept-Language": "en" } });
    if (!r.ok) throw new Error("search " + r.status);
    return (await r.json()).map((p) => {
      const a = p.address || {};
      return {
        name: p.name || String(p.display_name || "").split(",")[0], tz: "",
        region: [a.state, a.country].filter(Boolean).join(", "),
        lat: Math.round(+p.lat * 100) / 100, lon: Math.round(+p.lon * 100) / 100,
      };
    });
  }
}

export async function onRequestGet({ request }) {
  const u = new URL(request.url);
  const q = (u.searchParams.get("q") || "").trim();
  if (q) {
    try { return json({ results: await placeSearch(q.slice(0, 80)) }, 200, 3600); }
    catch (e) { return json({ error: "Place search unavailable" }, 502); }
  }
  const lat = parseFloat(u.searchParams.get("lat")), lon = parseFloat(u.searchParams.get("lon"));
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: "lat and lon required" }, 400);
  const tz = (u.searchParams.get("tz") || "").slice(0, 64);
  const why = [];
  try { return json(await openMeteo(lat, lon), 200, 300); } catch (e) { why.push(String(e.message || e)); }
  try { return json(await metNorway(lat, lon, tz), 200, 300); } catch (e) { why.push(String(e.message || e)); }
  return json({ error: "Weather service unavailable", detail: why }, 502);
}
