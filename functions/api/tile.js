// Map images for the Traffic tab, fetched here so the TomTom key never reaches the browser.
// GET /api/tile?l=base|flow&z=12&x=..&y=..   base = street map, flow = live traffic colors (transparent overlay)
const BLANK = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4XmNgYGBgAAAABQABGWkDzwAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const png = (body, maxAge) => new Response(body, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=" + maxAge } });

export async function onRequestGet({ env, request }) {
  const u = new URL(request.url), l = u.searchParams.get("l");
  const z = parseInt(u.searchParams.get("z"), 10), x = parseInt(u.searchParams.get("x"), 10), y = parseInt(u.searchParams.get("y"), 10);
  if (!(z >= 0 && z <= 20) || !(x >= 0 && x < 2 ** z) || !(y >= 0 && y < 2 ** z)) return new Response("bad tile", { status: 400 });
  const key = env.TOMTOM_KEY, live = l === "flow", ttl = live ? 120 : 86400;
  if (key) {
    const url = live
      ? `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?key=${encodeURIComponent(key)}&tileSize=256`
      : `https://api.tomtom.com/map/1/tile/basic/main/${z}/${x}/${y}.png?key=${encodeURIComponent(key)}&tileSize=256`;
    try {
      const r = await fetch(url, { cf: { cacheTtl: ttl, cacheEverything: true }, signal: AbortSignal.timeout(8000) });
      if (r.ok) return png(r.body, ttl);
    } catch (e) { /* fall through */ }
  }
  if (live) return png(BLANK, 60);
  // Backup street map: OpenStreetMap (light personal use).
  try {
    const r = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, { headers: { "User-Agent": "SombrioOhanaDashboard/1.0 (family dashboard)" }, cf: { cacheTtl: 86400, cacheEverything: true }, signal: AbortSignal.timeout(8000) });
    if (r.ok) return png(r.body, 86400);
  } catch (e) { /* ignore */ }
  return png(BLANK, 60);
}
