import { createServer } from "node:http";

const port = Number.parseInt(process.env.FIXTURE_STREMIO_PORT ?? "8091", 10);
const mediaOrigin =
  process.env.FIXTURE_MEDIA_ORIGIN ?? "http://fixture-origin:8090";
const mediaToken = process.env.FIXTURE_MEDIA_TOKEN ?? "stremio-upstream-secret";
const addonBase = "/stremio/test-user/test-secret";
const counts = {
  manifestRequests: 0,
  streamRequests: 0,
  streamByVideoId: {},
};

function json(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function urlCandidate(episode, family, filename) {
  return {
    name: `Fixture ${family}`,
    description: "Generic formatted Stremio stream",
    url: `${mediaOrigin}/episode${episode}.mkv?family=${family}&signed=temporary-${episode}`,
    behaviorHints: {
      bingeGroup: `family-${family}`,
      filename,
      videoSize: 350000 + episode * 1000,
      notWebReady: true,
      proxyHeaders: {
        request: { "X-Test-Token": mediaToken },
      },
    },
  };
}

function streamsFor(episode) {
  const familyA = urlCandidate(
    episode,
    "A",
    `[GroupA] Fixture Show - 0${episode}.1080p.mkv`,
  );
  const familyB = urlCandidate(
    episode,
    "B",
    `[GroupB] Fixture Show - 0${episode}.1080p.mkv`,
  );
  if (episode === 1) {
    return [
      { name: "Torrent", infoHash: "0123456789abcdef" },
      familyA,
      familyB,
      { name: "NZB", nzbUrl: "https://usenet.invalid/episode1.nzb" },
    ];
  }
  if (episode === 2) {
    return [
      familyB,
      familyA,
      { name: "Torrent", infoHash: "abcdef0123456789" },
    ];
  }
  if (episode === 3)
    return [
      familyA,
      familyB,
      { name: "External", externalUrl: "https://player.invalid/episode3" },
    ];
  return [familyA, familyB];
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture-stremio");
  if (url.pathname === "/health") return json(response, 200, { status: "ok" });
  if (url.pathname === "/stats") return json(response, 200, counts);
  if (url.pathname === `${addonBase}/manifest.json`) {
    counts.manifestRequests += 1;
    return json(response, 200, {
      id: "org.animetvcut.fixture",
      name: "Fixture AIOStreams-Compatible Addon",
      version: "1.0.0",
      types: ["series"],
      idPrefixes: ["tt", "fixture:"],
      resources: [
        {
          name: "stream",
          types: ["series"],
          idPrefixes: ["tt", "fixture:"],
        },
      ],
    });
  }
  const prefix = `${addonBase}/stream/series/`;
  if (url.pathname.startsWith(prefix) && url.pathname.endsWith(".json")) {
    const encodedId = url.pathname.slice(prefix.length, -".json".length);
    let videoId;
    try {
      videoId = decodeURIComponent(encodedId);
    } catch {
      return json(response, 400, { error: "invalid video id" });
    }
    const imdbMatch = /^tt1234567:1:([1-6])$/.exec(videoId);
    const opaqueMatch = /^fixture:opaque:episode:([1-6])$/.exec(videoId);
    const episodeText = imdbMatch?.[1] ?? opaqueMatch?.[1];
    if (episodeText === undefined) return json(response, 404, { streams: [] });
    const episode = Number(episodeText);
    counts.streamRequests += 1;
    counts.streamByVideoId[videoId] =
      (counts.streamByVideoId[videoId] ?? 0) + 1;
    return json(response, 200, { streams: streamsFor(episode) });
  }
  return json(response, 404, { error: "not found" });
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`fixture Stremio addon listening on ${port}\n`);
});
