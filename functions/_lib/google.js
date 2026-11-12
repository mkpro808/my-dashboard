// Shared helpers for talking to Google with the family's saved sign-in.
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are encrypted Cloudflare secrets.
// The long-lived sign-in (refresh token) is saved in the private D1 database.

export const SCOPE = "https://www.googleapis.com/auth/tasks";

export async function kvGet(db, k) {
  const r = await db.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first();
  return r ? r.v : null;
}
export async function kvSet(db, k, v) {
  await db.prepare("INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at")
    .bind(k, v, new Date().toISOString()).run();
}
export async function kvDel(db, k) {
  await db.prepare("DELETE FROM kv WHERE k = ?").bind(k).run();
}

export function configured(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.DB);
}

export function redirectUri(request) {
  return new URL(request.url).origin + "/api/google/callback";
}

// Returns a short-lived access token, refreshing it when needed. null if not connected.
export async function accessToken(env) {
  const cached = await kvGet(env.DB, "google_access");
  if (cached) {
    const c = JSON.parse(cached);
    if (c.exp > Date.now() + 60000) return c.token;
  }
  const refresh = await kvGet(env.DB, "google_refresh");
  if (!refresh) return null;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    if (j.error === "invalid_grant") {
      // Sign-in was revoked or expired; ask the family to reconnect.
      await kvDel(env.DB, "google_refresh");
      await kvDel(env.DB, "google_access");
    }
    return null;
  }
  await kvSet(env.DB, "google_access", JSON.stringify({ token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }));
  return j.access_token;
}

export async function gapi(token, method, path, body) {
  const r = await fetch("https://tasks.googleapis.com/tasks/v1" + path, {
    method,
    headers: Object.assign({ Authorization: "Bearer " + token }, body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Google " + r.status + ": " + ((j.error && j.error.message) || ""));
  return j;
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
