// Home tab: Kasa devices.
// The tablet at home runs a small helper (hub/kasa_hub.py in Termux) that talks to
// the devices. The dashboard open on that tablet passes the device list up to here,
// and picks up on/off requests left here by the phones.
import { kvGet, kvSet } from "../_lib/google.js";

const SK = "home_state", QK = "home_cmds", MAXAGE = 120000;

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
}
async function read(db, k, d) {
  try { const v = await kvGet(db, k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: "Database not connected" }, 503);
  const [state, q] = await Promise.all([read(env.DB, SK, null), read(env.DB, QK, { n: 0, list: [] })]);
  const now = Date.now();
  return json({ state, cmds: q.list.filter((c) => now - c.t < MAXAGE), now });
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return json({ error: "Database not connected" }, 503);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "Bad JSON" }, 400); }
  const now = Date.now();
  const q = await read(env.DB, QK, { n: 0, list: [] });
  let qChanged = false;
  q.list = q.list.filter((c) => now - c.t < MAXAGE);

  if (b.cmd || Array.isArray(b.cmds)) {
    const list = (b.cmds || [b.cmd]).slice(0, 40);
    let added = 0;
    for (const c of list) {
      const out = { id: String((c && c.id) || "").slice(0, 120), t: now };
      if (!out.id) continue;
      if (typeof c.on === "boolean") out.on = c.on;
      if (c.bri != null) out.bri = Math.max(1, Math.min(100, Math.round(+c.bri) || 1));
      if (out.on == null && out.bri == null) continue;
      q.n = (q.n || 0) + 1; out.n = q.n; added++;
      q.list = q.list.filter((x) => x.id !== out.id || (out.on == null) !== (x.on == null)).concat(out);
    }
    if (!added) return json({ error: "Nothing to change" }, 400);
    q.list = q.list.slice(-60);
    await kvSet(env.DB, QK, JSON.stringify(q));
    return json({ ok: true, n: q.n });
  }

  if (b.state) {
    const s = b.state;
    if (!Array.isArray(s.devices)) return json({ error: "Bad state" }, 400);
    const text = JSON.stringify({ devices: s.devices.slice(0, 80), unsupported: s.unsupported || 0, seen: now });
    if (text.length > 60000) return json({ error: "Too large" }, 413);
    await kvSet(env.DB, SK, text);
  }
  if (b.done) {
    const before = q.list.length;
    q.list = q.list.filter((c) => c.n > b.done);
    qChanged = q.list.length !== before;
  }
  if (qChanged) await kvSet(env.DB, QK, JSON.stringify(q));
  return json({ ok: true, cmds: q.list, now });
}
