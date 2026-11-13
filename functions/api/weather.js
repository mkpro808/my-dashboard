// Weather for the dashboard, fetched here (not in the browser) so it also works on
// networks that block the weather service. Data: Open-Meteo (free, no key).
// GET /api/weather?lat=21.28&lon=-157.75  -> current, hourly (7 days) and daily forecast
// GET /api/weather?q=Tokyo                -> place search for adding a location
function json(body, status = 200, cache = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": cache ? "private, max-age=" + cache : "no-store" },
  });
}

export async function onRequestGet({ request }) {
  const u = new URL(request.url);
  const q = (u.searchParams.get("q") || "").trim();
  try {
    if (q) {
      const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=" + encodeURIComponent(q.slice(0, 80)), { cf: { cacheTtl: 86400, cacheEverything: true } });
      const j = await r.json();
      const results = (j.results || []).map((p) => ({
        name: p.name, region: [p.admin1, p.country].filter(Boolean).join(", "),
        lat: Math.round(p.latitude * 100) / 100, lon: Math.round(p.longitude * 100) / 100,
      }));
      return json({ results }, 200, 3600);
    }
    const lat = parseFloat(u.searchParams.get("lat")), lon = parseFloat(u.searchParams.get("lon"));
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: "lat and lon required" }, 400);
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat.toFixed(2) + "&longitude=" + lon.toFixed(2) +
      "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day" +
      "&hourly=temperature_2m,precipitation_probability,weather_code,is_day" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,wind_speed_10m_max" +
      "&timezone=auto&forecast_days=7&temperature_unit=fahrenheit&wind_speed_unit=mph";
    const r = await fetch(url, { cf: { cacheTtl: 600, cacheEverything: true } });
    if (!r.ok) return json({ error: "Weather service " + r.status }, 502);
    return json(await r.json(), 200, 300);
  } catch (e) {
    return json({ error: "Weather service unavailable" }, 502);
  }
}
