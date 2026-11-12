// Google Photos for the slideshow, using Google's Photos Picker.
// The family picks photos (or an album's photos) in Google Photos; the dashboard copies
// them into the private R2 bucket bound as PHOTOS, then plays them from there.
// Choosing again replaces the previous set once the new copy is finished.
//
// GET  /api/photos              -> {ready, photos:[{id,url,w,h}], importing:{total,remaining}|null}
// POST /api/photos {op:'start'}  -> {uri}            open this to pick in Google Photos
// POST /api/photos {op:'poll'}   -> {waiting,pollMs} or {total}   after picking, queues the copy
// POST /api/photos {op:'import'} -> {remaining,total,done}       copies the next batch
import { configured, accessToken, kvGet, kvSet, kvDel, json } from "../_lib/google.js";

const API = "https://photospicker.googleapis.com/v1";
const BATCH = 12;

const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
async function curGen(db) { return +((await kvGet(db, "photos_gen")) || 0); }

async function pfetch(token, method, path) {
  const r = await fetch(API + path, { method, headers: { Authorization: "Bearer " + token } });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((j.error && j.error.message) || "Google Photos " + r.status);
    e.status = r.status;
    throw e;
  }
  return j;
}

async function status(env) {
  const gen = await curGen(env.DB);
  const rows = (await env.DB.prepare("SELECT id, w, h FROM photos WHERE gen = ? ORDER BY ord").bind(gen).all()).results || [];
  const imp = await kvGet(env.DB, "photos_import");
  let importing = null;
  if (imp) {
    const i = JSON.parse(imp);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM photo_queue WHERE gen = ?").bind(i.gen).first();
    importing = { total: i.total, remaining: left ? left.n : 0 };
  }
  return {
    ready: !!env.PHOTOS,
    connected: !!(await kvGet(env.DB, "google_refresh")),
    photos: rows.map((r) => ({ id: r.id, w: r.w, h: r.h, url: "/api/photo/" + r.id + "?g=" + gen })),
    importing,
  };
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ ready: false, photos: [] });
  return json(await status(env));
}

export async function onRequestPost({ env, request }) {
  if (!configured(env)) return json({ error: "Google isn't set up yet" }, 503);
  if (!env.PHOTOS) return json({ error: "Photo storage isn't connected yet", code: "storage" }, 503);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "Bad JSON" }, 400); }
  const token = await accessToken(env);
  if (!token) return json({ error: "Connect Google first", code: "connect" }, 401);
  try {
    if (b.op === "start") {
      const r = await fetch(API + "/sessions", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ pickingConfig: { maxItemCount: "2000" } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const scope = r.status === 403 || /scope|permission/i.test((j.error && j.error.message) || "");
        return json({ error: (j.error && j.error.message) || "Couldn't start Google Photos", code: scope ? "scope" : "google" }, r.status);
      }
      await kvSet(env.DB, "photos_session", JSON.stringify({ id: j.id, started: Date.now() }));
      return json({ uri: j.pickerUri.replace(/\/$/, "") + "/autoclose" });
    }

    if (b.op === "poll") {
      const raw = await kvGet(env.DB, "photos_session");
      if (!raw) return json({ error: "No photo picking in progress" }, 400);
      const sess = JSON.parse(raw);
      const s = await pfetch(token, "GET", "/sessions/" + encodeURIComponent(sess.id));
      if (!s.mediaItemsSet) {
        const ms = s.pollingConfig && s.pollingConfig.pollInterval ? Math.round(parseFloat(s.pollingConfig.pollInterval) * 1000) : 3000;
        return json({ waiting: true, pollMs: Math.min(Math.max(ms, 2000), 10000) });
      }
      // Picked: queue every photo for copying into a new set.
      const gen = (await curGen(env.DB)) + 1;
      await env.DB.prepare("DELETE FROM photo_queue").run();
      let page = "", ord = 0, stmts = [];
      for (let i = 0; i < 25; i++) {
        const j = await pfetch(token, "GET", "/mediaItems?sessionId=" + encodeURIComponent(sess.id) + "&pageSize=100" + (page ? "&pageToken=" + encodeURIComponent(page) : ""));
        for (const it of j.mediaItems || []) {
          if (it.type && it.type !== "PHOTO") continue;
          const f = it.mediaFile || {};
          const md = f.mediaFileMetadata || {};
          if (!f.baseUrl) continue;
          stmts.push(env.DB.prepare("INSERT OR IGNORE INTO photo_queue (id, gen, ord, url, mime, w, h) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(safeId(it.id), gen, ord++, f.baseUrl, f.mimeType || "image/jpeg", md.width || null, md.height || null));
        }
        if (!j.nextPageToken) break;
        page = j.nextPageToken;
      }
      for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
      await kvSet(env.DB, "photos_import", JSON.stringify({ gen, total: ord, session: sess.id }));
      await kvDel(env.DB, "photos_session");
      return json({ total: ord });
    }

    if (b.op === "import") {
      const raw = await kvGet(env.DB, "photos_import");
      if (!raw) return json({ done: true, remaining: 0 });
      const imp = JSON.parse(raw);
      const rows = (await env.DB.prepare("SELECT id, ord, url, mime, w, h FROM photo_queue WHERE gen = ? ORDER BY ord LIMIT ?").bind(imp.gen, BATCH).all()).results || [];
      let failed = 0;
      await Promise.all(rows.map(async (r) => {
        try {
          const res = await fetch(r.url + "=w2560-h2560", { headers: { Authorization: "Bearer " + token } });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const buf = await res.arrayBuffer();
          await env.PHOTOS.put("p/" + imp.gen + "/" + r.id, buf, { httpMetadata: { contentType: res.headers.get("Content-Type") || r.mime || "image/jpeg" } });
          await env.DB.prepare("INSERT OR REPLACE INTO photos (id, gen, ord, w, h) VALUES (?, ?, ?, ?, ?)").bind(r.id, imp.gen, r.ord, r.w, r.h).run();
        } catch (e) {
          failed++; // Google's links expire after an hour; skip anything that can't be copied.
        }
        await env.DB.prepare("DELETE FROM photo_queue WHERE gen = ? AND id = ?").bind(imp.gen, r.id).run();
      }));
      const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM photo_queue WHERE gen = ?").bind(imp.gen).first();
      const remaining = left ? left.n : 0;
      if (remaining === 0) {
        // Switch the slideshow to the new set, then remove the old photos.
        await kvSet(env.DB, "photos_gen", String(imp.gen));
        await kvDel(env.DB, "photos_import");
        const old = (await env.DB.prepare("SELECT id, gen FROM photos WHERE gen < ?").bind(imp.gen).all()).results || [];
        for (let i = 0; i < old.length; i += 1000) await env.PHOTOS.delete(old.slice(i, i + 1000).map((o) => "p/" + o.gen + "/" + o.id));
        await env.DB.prepare("DELETE FROM photos WHERE gen < ?").bind(imp.gen).run();
        try { await pfetch(token, "DELETE", "/sessions/" + encodeURIComponent(imp.session)); } catch (e) {}
      }
      return json({ remaining, total: imp.total, failed, done: remaining === 0 });
    }

    return json({ error: "Unknown request" }, 400);
  } catch (e) {
    const scope = e.status === 403;
    return json({ error: String(e.message || e), code: scope ? "scope" : "google" }, e.status || 502);
  }
}
