// Runs before every /api request.
// The main address is protected by Cloudflare Access (login). Cloudflare also gives
// every deployment its own extra address, so the API refuses to answer anywhere
// except the main, protected address.
export async function onRequest(ctx) {
  const host = new URL(ctx.request.url).hostname;
  const main = ctx.env.MAIN_HOST || "my-dashboard-azp.pages.dev";
  if (host !== main && host !== "localhost" && host !== "127.0.0.1") {
    return new Response("Not found", { status: 404 });
  }
  const res = await ctx.next();
  const out = new Response(res.body, res);
  if (!out.headers.has("Cache-Control")) out.headers.set("Cache-Control", "no-store");
  return out;
}
