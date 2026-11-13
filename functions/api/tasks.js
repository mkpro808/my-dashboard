// Google Tasks for the dashboard.
// GET  /api/tasks?chores=id1:d,id2:w,id3:m -> all lists and their items. Lists named in ?chores=
//                     are chore lists. Each resets on its own schedule: d = every morning,
//                     w = every Sunday, m = on the 1st, a = guess from the list's name.
//                     Without ?chores=, the list titled "Chores" is used (created if missing).
// POST /api/tasks  -> one change: {op:'add'|'toggle'|'delete'|'clear'|'newlist', list, id, title, done}
import { configured, accessToken, gapi, json } from "../_lib/google.js";

const CHORES = "chores";

function weekdayInZone(ms, tz) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(ms)));
}
function guessPeriod(title) {
  const t = String(title || "").toLowerCase();
  return /month/.test(t) ? "m" : /week/.test(t) ? "w" : "d";
}
// A chore can set its own rhythm with a tag in its name: (2d), (2w), (3m) = every 2 days / 2 weeks / 3 months.
// Cycles count from Sunday, January 4, 2026, so "every other week" always lands on the same Sundays.
function freqOf(title) {
  const m = /\((\d{1,2})\s*([dwm])\)/i.exec(String(title || ""));
  return m && +m[1] >= 1 ? { n: +m[1], u: m[2].toLowerCase() } : null;
}
const ANCHOR = Date.UTC(2026, 0, 4);
const ymdUTC = (ms) => new Date(ms).toISOString().slice(0, 10);
function freqStart(f, today) {
  const [y, mo, d] = today.split("-").map(Number);
  const days = Math.round((Date.UTC(y, mo - 1, d) - ANCHOR) / 86400000);
  if (f.u === "d") return ymdUTC(ANCHOR + Math.floor(days / f.n) * f.n * 86400000);
  if (f.u === "w") return ymdUTC(ANCHOR + Math.floor(days / (7 * f.n)) * 7 * f.n * 86400000);
  const months = (y - 2026) * 12 + (mo - 1), i = Math.floor(months / f.n) * f.n;
  return ymdUTC(Date.UTC(2026 + Math.floor(i / 12), ((i % 12) + 12) % 12, 1));
}
function periodStart(per, today, now, tz) {
  if (per === "m") return today.slice(0, 8) + "01";
  if (per === "w") return ymdInZone(now - weekdayInZone(now, tz) * 86400000, tz);
  return today;
}

function ymdInZone(ms, tz) {
  const o = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms))) o[p.type] = p.value;
  return o.year + "-" + o.month + "-" + o.day;
}

async function allItems(token, listId) {
  let items = [], page = "";
  for (let i = 0; i < 10; i++) {
    const q = "?showCompleted=true&showHidden=true&maxResults=100" + (page ? "&pageToken=" + encodeURIComponent(page) : "");
    const j = await gapi(token, "GET", "/lists/" + encodeURIComponent(listId) + "/tasks" + q);
    items = items.concat(j.items || []);
    if (!j.nextPageToken) break;
    page = j.nextPageToken;
  }
  return items
    .filter((t) => !t.deleted)
    .sort((a, b) => (a.position || "").localeCompare(b.position || ""))
    .map((t) => ({ id: t.id, title: t.title || "", done: t.status === "completed", completed: t.completed || null, hidden: !!t.hidden, notes: t.notes || "" }));
}

export async function onRequestGet({ env, request }) {
  if (!configured(env)) return json({ connected: false, configured: false });
  const token = await accessToken(env);
  if (!token) return json({ connected: false, configured: true });
  const tz = env.TIMEZONE || "Pacific/Honolulu";
  const today = ymdInZone(Date.now(), tz);
  try {
    const lists = (await gapi(token, "GET", "/users/@me/lists?maxResults=100")).items || [];
    const param = new URL(request.url).searchParams.get("chores");
    let choreIds, created = false;
    const per = {};
    if (param !== null) {
      const want = {};
      for (const part of param.split(",").filter(Boolean)) { const [id, p] = part.split(":"); want[id] = p || "a"; }
      choreIds = lists.filter((l) => want[l.id]).map((l) => l.id);
      for (const l of lists) if (want[l.id]) per[l.id] = /^[dwm]$/.test(want[l.id]) ? want[l.id] : guessPeriod(l.title);
    } else {
      let cl = lists.find((l) => (l.title || "").trim().toLowerCase() === CHORES);
      if (!cl) { cl = await gapi(token, "POST", "/users/@me/lists", { title: "Chores" }); lists.push(cl); created = true; }
      choreIds = [cl.id];
      per[cl.id] = guessPeriod(cl.title);
    }
    const now = Date.now();
    const items = await Promise.all(lists.map((l) => allItems(token, l.id)));

    // Reset: on each chore list, anything checked off before the current day/week/month goes back to "not done".
    const resets = [];
    lists.forEach((l, i) => {
      if (choreIds.indexOf(l.id) < 0) return;
      const listStart = periodStart(per[l.id], today, now, tz);
      for (const t of items[i]) {
        const f = freqOf(t.title), start = f ? freqStart(f, today) : listStart;
        if (t.done && (!t.completed || ymdInZone(Date.parse(t.completed), tz) < start)) resets.push([l.id, t]);
      }
    });
    await Promise.all(resets.map(([lid, t]) => gapi(token, "PATCH", "/lists/" + encodeURIComponent(lid) + "/tasks/" + encodeURIComponent(t.id), { status: "needsAction", completed: null })));
    for (const [, t] of resets) { t.done = false; t.completed = null; t.hidden = false; }

    return json({
      connected: true,
      today,
      created,
      choreIds,
      periods: per,
      lists: lists.map((l, i) => ({ id: l.id, title: l.title, items: items[i] })),
    });
  } catch (e) {
    return json({ connected: true, error: String(e.message || e) }, 502);
  }
}

export async function onRequestPost({ env, request }) {
  if (!configured(env)) return json({ error: "Google Tasks not set up" }, 503);
  const token = await accessToken(env);
  if (!token) return json({ error: "Not connected" }, 401);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "Bad JSON" }, 400); }
  const L = (id) => "/lists/" + encodeURIComponent(String(id || ""));
  const title = typeof b.title === "string" ? b.title.trim().slice(0, 500) : "";
  try {
    if (b.op === "add" && b.list && title) {
      const t = await gapi(token, "POST", L(b.list) + "/tasks", { title });
      return json({ ok: true, id: t.id });
    }
    if (b.op === "toggle" && b.list && b.id) {
      const body = b.done ? { status: "completed" } : { status: "needsAction", completed: null };
      await gapi(token, "PATCH", L(b.list) + "/tasks/" + encodeURIComponent(b.id), body);
      return json({ ok: true });
    }
    if (b.op === "rename" && b.list && b.id && title) {
      await gapi(token, "PATCH", L(b.list) + "/tasks/" + encodeURIComponent(b.id), { title });
      return json({ ok: true });
    }
    if (b.op === "delete" && b.list && b.id) {
      await gapi(token, "DELETE", L(b.list) + "/tasks/" + encodeURIComponent(b.id));
      return json({ ok: true });
    }
    if (b.op === "clear" && b.list) {
      await gapi(token, "POST", L(b.list) + "/clear");
      return json({ ok: true });
    }
    if (b.op === "newlist" && title) {
      const l = await gapi(token, "POST", "/users/@me/lists", { title });
      return json({ ok: true, id: l.id });
    }
    return json({ error: "Unknown change" }, 400);
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}
