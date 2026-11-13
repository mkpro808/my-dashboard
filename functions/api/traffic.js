// Live drive times for the Traffic tab. Data: TomTom Routing API (free tier, key in the
// TOMTOM_KEY secret). Results are kept for a few minutes in the database so several
// screens share one lookup, and a daily cap keeps use well inside the free allowance.
// GET /api/traffic?from=lat,lon&to=lat,lon[&arrive=HH:MM][&plan=1] -> now; with plan=1 also leaving-later and leave-by
// GET /api/traffic?geo=329 Main St                            -> address search for adding a drive
import { kvGet, kvSet } from "../_lib/google.js";

const UA = "SombrioOhanaDashboard/1.0 (family dashboard)";
const DAILY_CAP = 600;          // route lookups per day (free tier is 20,000 a month)
const NOW_TTL = 5 * 60000;      // live time refreshed at most every 5 minutes
const PLAN_TTL = 30 * 60000;    // "leaving later" and "leave by" refreshed every 30 minutes
const LATER = [15, 30, 45, 60, 90, 120];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
const pt = (s) => {
  const m = String(s || "").split(",").map(Number);
  return m.length === 2 && isFinite(m[0]) && isFinite(m[1]) && Math.abs(m[0]) <= 90 && Math.abs(m[1]) <= 180 ? [m[0].toFixed(5), m[1].toFixed(5)] : null;
};
function ymd(ms, tz) {
  const o = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
// Next time the clock reads HH:MM in the zone (today, or tomorrow if it has passed), as UTC ms.
function nextClock(hhmm, tz, now) {
  const [h, m] = hhmm.split(":").map(Number);
  const o = ymd(now, tz), offMin = (Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute) - Math.floor(now / 60000) * 60000) / 60000;
  let t = Date.UTC(+o.year, +o.month - 1, +o.day, h, m) - offMin * 60000;
  if (t < now + 5 * 60000) t += 86400000;
  return t;
}
const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";

async function budget(db, n) {
  const k = "traffic_count:" + new Date().toISOString().slice(0, 10);
  const used = +(await kvGet(db, k)) || 0;
  if (used + n > DAILY_CAP) return false;
  await kvSet(db, k, String(used + n));
  return true;
}

async function route(key, a, b, extra) {
  const url = "https://api.tomtom.com/routing/1/calculateRoute/" + a.join(",") + ":" + b.join(",") + "/json?key=" + encodeURIComponent(key) +
    "&traffic=true&travelMode=car&routeType=fastest&computeTravelTimeFor=all&routeRepresentation=summaryOnly" + (extra || "");
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("TomTom " + r.status);
  const s = (((await r.json()).routes || [])[0] || {}).summary;
  if (!s) throw new Error("No route found");
  return {
    min: Math.round(s.travelTimeInSeconds / 60),
    usual: Math.round((s.historicTrafficTravelTimeInSeconds || s.noTrafficTravelTimeInSeconds || s.travelTimeInSeconds) / 60),
    free: Math.round((s.noTrafficTravelTimeInSeconds || s.travelTimeInSeconds) / 60),
    delay: Math.round((s.trafficDelayInSeconds || 0) / 60),
    miles: Math.round((s.lengthInMeters / 1609.34) * 10) / 10,
    depart: s.departureTime, arrive: s.arrivalTime,
  };
}

async function geocode(env, q) {
  if (env.TOMTOM_KEY) {
    try {
      const r = await fetch("https://api.tomtom.com/search/2/search/" + encodeURIComponent(q) + ".json?key=" + encodeURIComponent(env.TOMTOM_KEY) +
        "&limit=6&lat=21.3&lon=-157.85&language=en-US", { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const res = ((await r.json()).results || []).filter((x) => x.position).map((x) => ({
          label: (x.poi && x.poi.name ? x.poi.name + ", " : "") + ((x.address || {}).freeformAddress || ""),
          lat: Math.round(x.position.lat * 1e5) / 1e5, lon: Math.round(x.position.lon * 1e5) / 1e5,
        }));
        if (res.length) return res;
      }
    } catch (e) { /* fall through to OpenStreetMap */ }
  }
  const r = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=" + encodeURIComponent(q), { headers: { "User-Agent": UA, "Accept-Language": "en" }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error("search " + r.status);
  return (await r.json()).map((p) => ({ label: String(p.display_name || "").split(",").slice(0, 4).join(",").trim(), lat: Math.round(+p.lat * 1e5) / 1e5, lon: Math.round(+p.lon * 1e5) / 1e5 }));
}

export async function onRequestGet({ env, request }) {
  const u = new URL(request.url);
  const geo = (u.searchParams.get("geo") || "").trim();
  if (geo) {
    try { return json({ results: await geocode(env, geo.slice(0, 120)) }); }
    catch (e) { return json({ error: "Address search unavailable" }, 502); }
  }
  const a = pt(u.searchParams.get("from")), b = pt(u.searchParams.get("to"));
  if (!a || !b) return json({ error: "from and to required" }, 400);
  if (!env.TOMTOM_KEY) return json({ configured: false });
  const arrive = /^\d{2}:\d{2}$/.test(u.searchParams.get("arrive") || "") ? u.searchParams.get("arrive") : "";
  const tz = env.TIMEZONE || "Pacific/Honolulu", key = env.TOMTOM_KEY, db = env.DB, now = Date.now();
  const ck = "traffic:" + a.join(",") + ">" + b.join(",") + (arrive ? "@" + arrive : "");
  let c = {};
  try { c = JSON.parse((await kvGet(db, ck)) || "{}"); } catch (e) { c = {}; }
  let paused = false, err = "";

  if (!c.now || now - c.now.t > NOW_TTL) {
    if (await budget(db, 1)) {
      try { c.now = { t: now, r: await route(key, a, b) }; } catch (e) { err = String(e.message || e); }
    } else paused = true;
  }
  const wantPlan = u.searchParams.get("plan") === "1";
  if (wantPlan && (!c.plan || now - c.plan.t > PLAN_TTL)) {
    if (await budget(db, LATER.length)) {
      const slot = Math.ceil(now / 900000) * 900000; // next quarter hour
      const later = await Promise.all(LATER.map((m) => {
        const t = slot + (m - 15) * 60000;
        return route(key, a, b, "&departAt=" + iso(t)).then((r) => ({ at: t, min: r.min })).catch(() => null);
      }));
      c.plan = { t: now, later: later.filter(Boolean) };
    } else paused = true;
  }
  // "Leave by" is cheap (one lookup per half hour), so it is kept fresh even on the compact card.
  if (arrive && (!c.lv || now - c.lv.t > PLAN_TTL || (c.lv.leave && c.lv.leave.by < now))) {
    if (await budget(db, 1)) {
      const t = nextClock(arrive, tz, now);
      let leave = null;
      try { const r = await route(key, a, b, "&arriveAt=" + iso(t)); leave = { by: t, depart: Date.parse(r.depart), min: r.min }; } catch (e) { leave = null; }
      c.lv = { t: now, leave };
    } else paused = true;
  }
  if (c.now || c.plan || c.lv) await kvSet(db, ck, JSON.stringify(c));
  if (!c.now) return json({ configured: true, error: err || "Daily traffic limit reached", paused }, 502);
  return json({ configured: true, updated: c.now.t, now: c.now.r, later: (c.plan || {}).later || [], leave: (arrive && c.lv && c.lv.leave) || null, paused });
}
