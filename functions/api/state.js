// Shared dashboard data (people, chores, stars, lists, reminders, events),
// stored as one JSON document in the D1 database bound as DB.
const ID = "main";
const MAX = 900000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function current(db) {
  const row = await db.prepare("SELECT data, version FROM app_state WHERE id = ?").bind(ID).first();
  return row ? { data: JSON.parse(row.data), version: row.version } : { data: null, version: 0 };
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: "Database not connected" }, 503);
  return json(await current(env.DB));
}

export async function onRequestPut({ env, request }) {
  if (!env.DB) return json({ error: "Database not connected" }, 503);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Bad JSON" }, 400); }
  if (!body || typeof body.data !== "object" || body.data === null || typeof body.version !== "number") {
    return json({ error: "Expected {data, version}" }, 400);
  }
  const text = JSON.stringify(body.data);
  if (text.length > MAX) return json({ error: "Too large" }, 413);
  const now = new Date().toISOString();
  let res;
  if (body.version === 0) {
    res = await env.DB.prepare("INSERT OR IGNORE INTO app_state (id, data, version, updated_at) VALUES (?, ?, 1, ?)").bind(ID, text, now).run();
  } else {
    res = await env.DB.prepare("UPDATE app_state SET data = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").bind(text, now, ID, body.version).run();
  }
  if (!res.meta || res.meta.changes !== 1) {
    // Someone else saved first. Send back the latest copy.
    return json(Object.assign({ conflict: true }, await current(env.DB)), 409);
  }
  return json({ version: body.version + 1 });
}
