// Google Tasks for the dashboard.
// GET  /api/tasks  -> all lists and their items. The list named "Chores" is returned
//                     separately, and chores checked off on an earlier day are reset.
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

export async function onRequestGet({ env }) {
  if (!configured(env)) return json({ connected: false, configured: false });
  const token = await accessToken(env);
  if (!token) return json({ connected: false, configured: true });
  const tz = env.TIMEZONE || "Pacific/Honolulu";
  const today = ymdInZone(Date.now(), tz);
  try {
    const lists = (await gapi(token, "GET", "/users/@me/lists?maxResults=100")).items || [];
    let choresList = lists.find((l) => (l.title || "").trim().toLowerCase() === CHORES);
    let created = false;
    if (!choresList) {
      choresList = await gapi(token, "POST", "/users/@me/lists", { title: "Chores" });
      created = true;
    }
    const others = lists.filter((l) => l.id !== choresList.id);
    const [choreItems, ...otherItems] = await Promise.all([allItems(token, choresList.id)].concat(others.map((l) => allItems(token, l.id))));

    // Daily reset: chores checked off before today go back to "not done".
    const resets = choreItems.filter((t) => t.done && (!t.completed || ymdInZone(Date.parse(t.completed), tz) < today));
    await Promise.all(resets.map((t) => gapi(token, "PATCH", "/lists/" + encodeURIComponent(choresList.id) + "/tasks/" + encodeURIComponent(t.id), { status: "needsAction", completed: null })));
    for (const t of resets) { t.done = false; t.completed = null; t.hidden = false; }

    return json({
      connected: true,
      today,
      chores: { id: choresList.id, created, items: choreItems },
      lists: others.map((l, i) => ({ id: l.id, title: l.title, items: otherItems[i].filter((t) => !t.hidden) })),
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
