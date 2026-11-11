import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/tiles/$z/$x/$y")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const z = Number(params.z);
        const x = Number(params.x);
        const y = Number(String(params.y).replace(/\.png$/, ""));
        const limit = 2 ** z;
        if (!Number.isInteger(z) || z < 0 || z > 19 || !Number.isInteger(x) || !Number.isInteger(y)) {
          return new Response(null, { status: 400 });
        }
        if (x < 0 || y < 0 || x >= limit || y >= limit) {
          return new Response(null, { status: 400 });
        }
        const sources = [
          `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
          `https://a.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`,
        ];
        for (const url of sources) {
          try {
            const upstream = await fetch(url, {
              headers: { "user-agent": "LndnBusesLive/1.0 (London bus map)" },
              signal: AbortSignal.timeout(8_000),
            });
            if (!upstream.ok) continue;
            const bytes = await upstream.arrayBuffer();
            return new Response(bytes, {
              headers: {
                "content-type": "image/png",
                "cache-control": "public, max-age=86400",
              },
            });
          } catch {
            /* try the next tile server */
          }
        }
        return new Response(null, { status: 502 });
      },
    },
  },
});
