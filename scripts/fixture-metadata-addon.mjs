import { createServer } from "node:http";

const port = Number.parseInt(process.env.FIXTURE_METADATA_PORT ?? "8092", 10);
const addonBase = "/metadata/test-user/metadata-secret";
const counts = { manifestRequests: 0, catalogRequests: 0, metaRequests: 0 };

function json(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(body);
}

function videos(mode) {
  return Array.from({ length: 12 }, (_, index) => {
    const season = index < 6 ? 1 : 2;
    const episode = (index % 6) + 1;
    return {
      id:
        mode === "imdb"
          ? `tt1234567:${season}:${episode}`
          : season === 1
            ? `fixture:opaque:episode:${episode}`
            : `fixture:opaque:season2:episode:${episode}`,
      season,
      episode,
      title: `Synthetic S${season}E${episode}`,
      released: `2025-0${season}-${String(episode).padStart(2, "0")}T00:00:00.000Z`,
      thumbnail: `https://images.invalid/s${season}e${episode}.jpg`,
    };
  });
}

function preview(mode) {
  return {
    id: mode === "imdb" ? "tt1234567" : "fixture:opaque:series:α",
    type: "series",
    name: mode === "imdb" ? "Synthetic Twelve IMDb" : "Synthetic Twelve Opaque",
    poster: "https://images.invalid/synthetic-six.jpg",
    posterShape: "poster",
    background: "https://images.invalid/synthetic-six-background.jpg",
    description: "Generated test media with two six-episode seasons.",
    releaseInfo: "2025",
    genres: ["Animation", "Test"],
  };
}

function meta(mode) {
  return { ...preview(mode), runtime: "24 min", videos: videos(mode) };
}

function decodeResourceId(pathname, prefix) {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(".json"))
    return undefined;
  try {
    return decodeURIComponent(pathname.slice(prefix.length, -5));
  } catch {
    return undefined;
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture-metadata");
  if (url.pathname === "/health") return json(response, 200, { status: "ok" });
  if (url.pathname === "/stats") return json(response, 200, counts);
  if (url.pathname === `${addonBase}/manifest.json`) {
    counts.manifestRequests += 1;
    return json(response, 200, {
      id: "org.animetvcut.fixture.metadata",
      name: "Fixture AIOMetadata-Compatible Addon",
      version: "1.0.0",
      types: ["movie", "series"],
      resources: ["catalog", { name: "meta", types: ["series"] }],
      catalogs: [
        {
          id: "fixture-movies",
          type: "movie",
          name: "Movies",
          extra: [{ name: "search", isRequired: true }],
        },
        { id: "fixture-unsearchable", type: "series", name: "Browse only" },
        {
          id: "fixture-series-primary",
          type: "series",
          name: "Series primary",
          extra: [
            { name: "search", isRequired: true },
            { name: "skip", isRequired: false },
          ],
        },
        {
          id: "fixture-series-secondary",
          type: "series",
          name: "Series secondary",
          extra: [{ name: "search", isRequired: true }],
        },
      ],
    });
  }

  const catalogPrefix = `${addonBase}/catalog/series/fixture-series-primary/`;
  if (
    url.pathname.startsWith(catalogPrefix) &&
    url.pathname.endsWith(".json")
  ) {
    counts.catalogRequests += 1;
    let extras;
    try {
      extras = new URL(
        `http://fixture/?${decodeURIComponent(url.pathname.slice(catalogPrefix.length, -5))}`,
      ).searchParams;
    } catch {
      return json(response, 400, { metas: [] });
    }
    const query = (extras.get("search") ?? "").toLowerCase();
    const skip = Number(extras.get("skip") ?? "0");
    const all = [preview("imdb"), preview("opaque")].filter((item) =>
      item.name.toLowerCase().includes(query),
    );
    return json(response, 200, { metas: all.slice(skip) });
  }

  const sourceId = decodeResourceId(url.pathname, `${addonBase}/meta/series/`);
  if (sourceId !== undefined) {
    counts.metaRequests += 1;
    if (sourceId === "tt1234567")
      return json(response, 200, { meta: meta("imdb") });
    if (sourceId === "fixture:opaque:series:α") {
      return json(response, 200, { meta: meta("opaque") });
    }
    return json(response, 404, { meta: null });
  }
  return json(response, 404, { error: "not found" });
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`fixture metadata addon listening on ${port}\n`);
});
