// Google sends the family back here after they approve access.
import { configured, redirectUri, kvSet, kvDel } from "../../_lib/google.js";

function back(msg) {
  return new Response(null, {
    status: 302,
    headers: { Location: "/?google=" + msg, "Set-Cookie": "g_state=; Path=/api/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax" },
  });
}

export async function onRequestGet({ env, request }) {
  if (!configured(env)) return back("notsetup");
  const url = new URL(request.url);
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)g_state=([^;]+)/);
  if (!m || m[1] !== url.searchParams.get("state")) return back("expired");
  if (url.searchParams.get("error")) return back("cancelled");
  const code = url.searchParams.get("code");
  if (!code) return back("cancelled");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(request),
      grant_type: "authorization_code",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) return back("failed");
  await kvSet(env.DB, "google_refresh", j.refresh_token);
  await kvDel(env.DB, "google_access");
  return back("connected");
}
