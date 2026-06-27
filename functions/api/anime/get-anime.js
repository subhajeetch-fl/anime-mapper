export async function onRequest(context) {
  const { id } = context.params;

  if (!id) {
    return new Response(
      JSON.stringify({
        error: "Missing anime id"
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }

  // Fetch the static JSON from /data/anime/
  const url = new URL(`/data/anime/${id}.json`, context.request.url);

  const response = await context.env.ASSETS.fetch(url);

  if (!response.ok) {
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

  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300, s-maxage=86400"
    }
  });
}