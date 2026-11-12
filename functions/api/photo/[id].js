// Serves one slideshow photo from the private R2 bucket (behind the dashboard login).
export async function onRequestGet({ env, params, request }) {
  if (!env.PHOTOS || !env.DB) return new Response("Not found", { status: 404 });
  const id = String(params.id || "").replace(/[^A-Za-z0-9_-]/g, "");
  let gen = new URL(request.url).searchParams.get("g");
  if (!/^\d+$/.test(gen || "")) {
    const r = await env.DB.prepare("SELECT v FROM kv WHERE k = 'photos_gen'").first();
    gen = r ? r.v : "0";
  }
  const obj = await env.PHOTOS.get("p/" + gen + "/" + id);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "Content-Type": (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg",
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: obj.httpEtag,
    },
  });
}
