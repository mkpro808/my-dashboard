// Google Tasks for the dashboard.
// GET  /api/tasks?chores=id1,id2 -> all lists and their items. Lists named in ?chores=
//                     are chore lists: anything checked off on an earlier day is reset.
//                     Without ?chores=, the list titled "Chores" is used (created if missing).
// POST /api/tasks  -> one change: {op:'add'|'toggle'|'delete'|'clear'|'newlist', list, id, title, done}
import { configured, accessToken, gapi, json } from "../_lib/google.js";

const CHORES = "chores";

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
    if (param !== null) {
      const want = param.split(",").filter(Boolean);
      choreIds = lists.filter((l) => want.indexOf(l.id) >= 0).map((l) => l.id);
    } else {
      let cl = lists.find((l) => (l.title || "").trim().toLowerCase() === CHORES);
      if (!cl) { cl = await gapi(token, "POST", "/users/@me/lists", { title: "Chores" }); lists.push(cl); created = true; }
      choreIds = [cl.id];
    }
    const items = await Promise.all(lists.map((l) => allItems(token, l.id)));

    // Daily reset: on chore lists, anything checked off before today goes back to "not done".
    const resets = [];
    lists.forEach((l, i) => {
      if (choreIds.indexOf(l.id) < 0) return;
      for (const t of items[i]) {
        if (t.done && (!t.completed || ymdInZone(Date.parse(t.completed), tz) < today)) resets.push([l.id, t]);
      }
    });
    await Promise.all(resets.map(([lid, t]) => gapi(token, "PATCH", "/lists/" + encodeURIComponent(lid) + "/tasks/" + encodeURIComponent(t.id), { status: "needsAction", completed: null })));
    for (const [, t] of resets) { t.done = false; t.completed = null; t.hidden = false; }

    return json({
      connected: true,
      today,
      created,
      choreIds,
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
