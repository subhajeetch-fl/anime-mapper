/**
 * Cloudflare Pages Function
 * Route: /api/anime/:id
 *
 * Serves:
 * data/anime/{bucket}/{id}.json
 */

function getBucketName(id) {
  if (id >= 1000000) return "other";

  const bucket = Math.floor(id / 1000);
  return String(bucket).padStart(3, "0");
}

export async function onRequest(context) {
  const rawId = context.params.id;

  // Validate input
  if (!rawId || !/^\d+$/.test(rawId)) {
    return new Response(
      JSON.stringify({
        error: "Invalid anime id"
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }

  const id = Number(rawId);

  if (!Number.isSafeInteger(id) || id <= 0) {
    return new Response(
      JSON.stringify({
        error: "Invalid anime id"
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }

  const bucket = getBucketName(id);

  const assetUrl = new URL(
    `/data/anime/${bucket}/${id}.json`,
    context.request.url
  );

  const asset = await context.env.ASSETS.fetch(assetUrl);

  if (!asset.ok) {
    return new Response(
      JSON.stringify({
        error: "Anime not found"
      }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }

  return new Response(asset.body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Browser: 5 minutes
      // Cloudflare CDN: 24 hours
      "Cache-Control": "public, max-age=300, s-maxage=86400"
    }
  });
}