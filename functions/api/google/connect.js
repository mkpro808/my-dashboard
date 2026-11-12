// Starts the one-time "Connect Google Tasks" sign-in.
import { configured, redirectUri, SCOPE } from "../../_lib/google.js";

export async function onRequestGet({ env, request }) {
  if (!configured(env)) {
    return new Response("Google Tasks isn't set up yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Cloudflare, and connect the DB database.", { status: 503 });
  }
  const state = crypto.randomUUID();
  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(request),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Set-Cookie": "g_state=" + state + "; Path=/api/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax",
    },
  });
}
