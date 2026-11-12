// Reads Google Calendar "secret address in iCal format" links and returns events as JSON.
// Each link is stored as an encrypted Cloudflare secret whose name starts with ICS_,
// for example ICS_JERICHO or ICS_KAHOKU. The part after ICS_ becomes the calendar's
// label, and it is matched to a person's name on the dashboard to pick the color.
// The links never appear in the code or the browser.

const DAY = 86400000;

export async function onRequestGet({ env }) {
  const tz = env.TIMEZONE || "Pacific/Honolulu";
  const feeds = Object.keys(env)
    .filter((k) => k.startsWith("ICS_") && typeof env[k] === "string" && env[k].startsWith("http"))
    .sort();
  const today = ymdInZone(Date.now(), tz);
  const winStart = addDaysYmd(today, -45);
  const winEnd = addDaysYmd(today, 190);
  const events = [];
  const errors = [];
  await Promise.all(
    feeds.map(async (key) => {
      const label = key.slice(4).toLowerCase().split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      try {
        const r = await fetch(env[key], { cf: { cacheTtl: 300, cacheEverything: true } });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const text = await r.text();
        for (const e of icsToEvents(text, tz, winStart, winEnd)) {
          e.cal = label;
          events.push(e);
        }
      } catch (err) {
        errors.push(label);
      }
    })
  );
  events.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  return new Response(JSON.stringify({ events, errors, calendars: feeds.length, tz }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- date helpers ----------
const fmtCache = {};
function fmt(tz) {
  if (!fmtCache[tz]) {
    fmtCache[tz] = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }
  return fmtCache[tz];
}
function partsInZone(ms, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
function offset(ms, tz) {
  const p = partsInZone(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
function zonedToUtc(y, m, d, h, mi, s, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  let res = guess - offset(guess, tz);
  const off2 = offset(res, tz);
  if (guess - off2 !== res) res = guess - off2;
  return res;
}
function validTz(tz) {
  try { fmt(tz); return true; } catch (e) { return false; }
}
const p2 = (n) => (n < 10 ? "0" : "") + n;
function ymd(y, m, d) { return y + "-" + p2(m) + "-" + p2(d); }
function ymdInZone(ms, tz) { const p = partsInZone(ms, tz); return ymd(p.y, p.m, p.d); }
function hmInZone(ms, tz) { const p = partsInZone(ms, tz); return p2(p.h) + ":" + p2(p.mi); }
function ymdToUtcMs(s) { const a = s.split("-"); return Date.UTC(+a[0], +a[1] - 1, +a[2]); }
function addDaysYmd(s, n) { const t = new Date(ymdToUtcMs(s) + n * DAY); return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function weekday(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }

// ---------- ICS parsing ----------
function unescapeText(v) {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}
function parseLine(line) {
  // NAME;PARAM=VAL;PARAM2="x:y":VALUE  (colons can appear inside quoted params)
  let i = 0, inQ = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ":" && !inQ) break;
  }
  const head = line.slice(0, i), value = line.slice(i + 1);
  const segs = head.split(";");
  const params = {};
  for (const s of segs.slice(1)) {
    const eq = s.indexOf("=");
    if (eq > 0) params[s.slice(0, eq).toUpperCase()] = s.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: segs[0].toUpperCase(), params, value };
}
// Returns {allDay, y,m,d, h,mi,s, tz|null, utc:boolean}
function parseDate(prop, defTz) {
  if (!prop) return null;
  const v = prop.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const out = { y: +m[1], m: +m[2], d: +m[3] };
  if (!m[4] || prop.params.VALUE === "DATE") { out.allDay = true; return out; }
  out.allDay = false;
  out.h = +m[4]; out.mi = +m[5]; out.s = +(m[6] || 0);
  if (m[7]) { out.tz = "UTC"; }
  else if (prop.params.TZID && validTz(prop.params.TZID)) { out.tz = prop.params.TZID; }
  else { out.tz = defTz; }
  return out;
}
function toMs(dt) { return zonedToUtc(dt.y, dt.m, dt.d, dt.h, dt.mi, dt.s, dt.tz); }
function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec((v || "").trim());
  if (!m) return null;
  const ms = (+(m[2] || 0) * 7 + +(m[3] || 0)) * DAY + (+(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}
function parseRRule(v) {
  const r = {};
  for (const part of v.split(";")) {
    const [k, val] = part.split("=");
    if (k && val !== undefined) r[k.toUpperCase()] = val;
  }
  return r;
}

function readVevents(text) {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const raw of lines) {
    if (!raw) continue;
    if (raw === "BEGIN:VEVENT") { cur = { multi: {} }; continue; }
    if (raw === "END:VEVENT") { if (cur) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    if (raw.startsWith("BEGIN:")) { cur.skip = (cur.skip || 0) + 1; continue; } // e.g. VALARM
    if (raw.startsWith("END:")) { cur.skip = Math.max(0, (cur.skip || 0) - 1); continue; }
    if (cur.skip) continue;
    const p = parseLine(raw);
    if (p.name === "EXDATE") (cur.multi.EXDATE = cur.multi.EXDATE || []).push(p);
    else cur[p.name] = p;
  }
  return out;
}

// ---------- recurrence ----------
const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function parseByDay(s) {
  return (s || "").split(",").filter(Boolean).map((x) => {
    const m = x.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
    return m ? { n: m[1] ? +m[1] : 0, wd: DAYS[m[2]] } : null;
  }).filter(Boolean);
}
function nthWeekdays(y, m, wd, n) {
  const all = [];
  const dim = daysInMonth(y, m);
  for (let d = 1; d <= dim; d++) if (weekday(y, m, d) === wd) all.push(d);
  if (!n) return all;
  const pick = n > 0 ? all[n - 1] : all[all.length + n];
  return pick ? [pick] : [];
}
function monthDays(y, m, rule, startDay) {
  const dim = daysInMonth(y, m);
  let days = [];
  if (rule.BYMONTHDAY) {
    for (const x of rule.BYMONTHDAY.split(",")) {
      const n = +x;
      const d = n > 0 ? n : dim + n + 1;
      if (d >= 1 && d <= dim) days.push(d);
    }
  } else if (rule.BYDAY) {
    for (const b of parseByDay(rule.BYDAY)) days = days.concat(nthWeekdays(y, m, b.wd, b.n));
  } else if (startDay <= dim) {
    days.push(startDay);
  }
  return Array.from(new Set(days)).sort((a, b) => a - b);
}

// Yields occurrence dates (y,m,d) in the event's own wall-clock calendar.
function* occurrenceDates(start, rule, untilYmd, hardEnd) {
  const freq = rule.FREQ;
  const interval = Math.max(1, +(rule.INTERVAL || 1));
  const startYmd = ymd(start.y, start.m, start.d);
  const startMs = ymdToUtcMs(startYmd);
  const endYmd = untilYmd && untilYmd < hardEnd ? untilYmd : hardEnd;
  let guard = 0;
  if (freq === "DAILY") {
    for (let i = 0; guard++ < 20000; i += interval) {
      const t = new Date(startMs + i * DAY);
      const s = ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
      if (s > endYmd) return;
      yield s;
    }
  } else if (freq === "WEEKLY") {
    const wkst = DAYS[rule.WKST] !== undefined ? DAYS[rule.WKST] : 1;
    const byd = rule.BYDAY ? parseByDay(rule.BYDAY).map((b) => b.wd) : [weekday(start.y, start.m, start.d)];
    const back = (weekday(start.y, start.m, start.d) - wkst + 7) % 7;
    const weekStart = startMs - back * DAY;
    for (let w = 0; guard++ < 5000; w += interval) {
      const ws = weekStart + w * 7 * DAY;
      const list = [];
      for (let k = 0; k < 7; k++) {
        const t = new Date(ws + k * DAY);
        if (byd.indexOf(t.getUTCDay()) >= 0) list.push(ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()));
      }
      for (const s of list) {
        if (s < startYmd) continue;
        if (s > endYmd) return;
        yield s;
      }
    }
  } else if (freq === "MONTHLY") {
    for (let i = 0; guard++ < 2400; i += interval) {
      const mi = start.m - 1 + i, y = start.y + Math.floor(mi / 12), m = (mi % 12) + 1;
      if (ymd(y, m, 1) > endYmd) return;
      for (const d of monthDays(y, m, rule, start.d)) {
        const s = ymd(y, m, d);
        if (s < startYmd) continue;
        if (s > endYmd) return;
        yield s;
      }
    }
  } else if (freq === "YEARLY") {
    const months = rule.BYMONTH ? rule.BYMONTH.split(",").map(Number).sort((a, b) => a - b) : [start.m];
    for (let i = 0; guard++ < 300; i += interval) {
      const y = start.y + i;
      if (ymd(y, 1, 1) > endYmd) return;
      for (const m of months) {
        const days = rule.BYMONTHDAY || rule.BYDAY ? monthDays(y, m, rule, start.d) : (start.d <= daysInMonth(y, m) ? [start.d] : []);
        for (const d of days) {
          const s = ymd(y, m, d);
          if (s < startYmd) continue;
          if (s > endYmd) return;
          yield s;
        }
      }
    }
  }
}

function icsToEvents(text, tz, winStart, winEnd) {
  const vevents = readVevents(text);
  const overridden = {}; // uid -> Set of original start keys replaced by edited copies
  for (const ev of vevents) {
    if (ev["RECURRENCE-ID"] && ev.UID) {
      const rid = parseDate(ev["RECURRENCE-ID"], tz);
      if (rid) (overridden[ev.UID.value] = overridden[ev.UID.value] || new Set()).add(rid.allDay ? "d" + ymd(rid.y, rid.m, rid.d) : "t" + toMs(rid));
    }
  }
  const out = [];
  const winStartMs = ymdToUtcMs(winStart) - DAY; // generous margin; filtered by date below
  for (const ev of vevents) {
    if (ev.STATUS && ev.STATUS.value.toUpperCase() === "CANCELLED") continue;
    const start = parseDate(ev.DTSTART, tz);
    if (!start) continue;
    const title = ev.SUMMARY ? unescapeText(ev.SUMMARY.value) : "(No title)";
    const loc = ev.LOCATION ? unescapeText(ev.LOCATION.value) : "";
    const uid = ev.UID ? ev.UID.value : title + ymd(start.y, start.m, start.d);
    const end = parseDate(ev.DTEND, tz);
    const dur = ev.DURATION ? parseDuration(ev.DURATION.value) : null;

    // Length of one occurrence
    let lenDays = 1, lenMs = 3600000;
    if (start.allDay) {
      if (end && end.allDay) lenDays = Math.max(1, Math.round((ymdToUtcMs(ymd(end.y, end.m, end.d)) - ymdToUtcMs(ymd(start.y, start.m, start.d))) / DAY));
      else if (dur) lenDays = Math.max(1, Math.round(dur / DAY));
    } else {
      if (end && !end.allDay) lenMs = Math.max(0, toMs(end) - toMs(start));
      else if (dur !== null) lenMs = Math.max(0, dur);
    }

    // Excluded dates
    const ex = new Set();
    for (const p of (ev.multi.EXDATE || [])) {
      for (const val of p.value.split(",")) {
        const d = parseDate({ value: val, params: p.params }, tz);
        if (!d) continue;
        if (d.allDay) ex.add("d" + ymd(d.y, d.m, d.d));
        else { ex.add("t" + toMs(d)); ex.add("d" + ymd(d.y, d.m, d.d)); }
      }
    }
    const skip = overridden[uid] && !ev["RECURRENCE-ID"] ? overridden[uid] : new Set();

    // Build list of occurrence start dates (wall clock of the event's zone)
    let dates;
    if (ev.RRULE && !ev["RECURRENCE-ID"]) {
      const rule = parseRRule(ev.RRULE.value);
      let untilYmd = null, untilMs = null;
      if (rule.UNTIL) {
        const u = parseDate({ value: rule.UNTIL, params: {} }, "UTC");
        if (u) {
          if (u.allDay) untilYmd = ymd(u.y, u.m, u.d);
          else { untilMs = toMs(u); untilYmd = start.allDay ? ymdInZone(untilMs, "UTC") : ymdInZone(untilMs, start.tz); }
        }
      }
      const count = rule.COUNT ? +rule.COUNT : Infinity;
      dates = [];
      let n = 0;
      for (const s of occurrenceDates(start, rule, untilYmd, winEnd)) {
        if (++n > count) break;
        if (untilMs !== null && !start.allDay) {
          const a = s.split("-").map(Number);
          if (zonedToUtc(a[0], a[1], a[2], start.h, start.mi, start.s, start.tz) > untilMs) break;
        }
        dates.push(s);
      }
    } else {
      dates = [ymd(start.y, start.m, start.d)];
    }

    for (const s of dates) {
      if (start.allDay) {
        if (ex.has("d" + s) || skip.has("d" + s)) continue;
        for (let k = 0; k < lenDays; k++) {
          const day = addDaysYmd(s, k);
          if (day < winStart || day > winEnd) continue;
          out.push({ id: uid + "|" + day, title, loc, date: day, time: "", end: "", allDay: true });
        }
      } else {
        const a = s.split("-").map(Number);
        const sMs = zonedToUtc(a[0], a[1], a[2], start.h, start.mi, start.s, start.tz);
        if (ex.has("t" + sMs) || skip.has("t" + sMs)) continue;
        if (sMs < winStartMs) continue;
        const eMs = sMs + lenMs;
        const sDay = ymdInZone(sMs, tz);
        if (sDay > winEnd) continue;
        // End is exclusive, so an event ending exactly at midnight stays on one day
        const eDay = lenMs > 0 ? ymdInZone(eMs - 1, tz) : sDay;
        if (eDay === sDay) {
          if (sDay < winStart) continue;
          out.push({ id: uid + "|" + sMs, title, loc, date: sDay, time: hmInZone(sMs, tz), end: lenMs > 0 ? hmInZone(eMs, tz) : "", allDay: false });
        } else {
          // Spans midnight: first day until 23:59, later days shown as all-day
          if (sDay >= winStart) out.push({ id: uid + "|" + sMs, title, loc, date: sDay, time: hmInZone(sMs, tz), end: "23:59", allDay: false });
          for (let d = addDaysYmd(sDay, 1), g = 0; d <= eDay && g < 60; d = addDaysYmd(d, 1), g++) {
            if (d < winStart || d > winEnd) continue;
            out.push({ id: uid + "|" + sMs + "|" + d, title, loc, date: d, time: "", end: "", allDay: true });
          }
        }
      }
    }
  }
  return out;
}

