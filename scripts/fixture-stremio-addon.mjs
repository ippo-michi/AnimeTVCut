import { createServer } from "node:http";

const port = Number.parseInt(process.env.FIXTURE_STREMIO_PORT ?? "8091", 10);
const mediaOrigin =
  process.env.FIXTURE_MEDIA_ORIGIN ?? "http://fixture-origin:8090";
const mediaToken = process.env.FIXTURE_MEDIA_TOKEN ?? "stremio-upstream-secret";
const subtitleOrigin =
  process.env.FIXTURE_SUBTITLE_ORIGIN ?? "http://127.0.0.1:19093";
const addonBase = "/stremio/test-user/test-secret";
const counts = {
  manifestRequests: 0,
  streamRequests: 0,
  streamByVideoId: {},
  subtitleRequests: 0,
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

function urlCandidate(episode, family, filename, attachedSubtitles) {
  return {
    name: `Fixture ${family}`,
    description: "Generic formatted Stremio stream",
    url: `${mediaOrigin}/episode${episode}.mkv?family=${family}&signed=temporary-${episode}`,
    behaviorHints: {
      bingeGroup: `family-${family}`,
      filename,
      videoSize: 350000 + episode * 1000,
      videoHash: `fixture-hash-${episode}`,
      notWebReady: true,
      proxyHeaders: {
        request: { "X-Test-Token": mediaToken },
      },
    },
    ...(attachedSubtitles
      ? {
          subtitles: [
            {
              id: "english-full",
              url: `${subtitleOrigin}/episode${episode}.eng.srt?signed=subtitle-secret-${episode}`,
              lang: "eng",
            },
            {
              id: "japanese-styled",
              url: `${subtitleOrigin}/episode${episode}.jpn.ass?signed=subtitle-secret-${episode}`,
              lang: "jpn",
            },
            { id: "malformed", url: "file:///etc/passwd", lang: "eng" },
          ],
        }
      : {}),
  };
}

function streamsFor(episode, season) {
  const primary = season === 1 ? "A" : "B";
  const alternate = season === 1 ? "C" : "D";
  const familyA = urlCandidate(
    episode,
    primary,
    season === 1
      ? `[Group${primary}] Fixture Show - 0${episode}.1080p.mkv`
      : `[Group${primary}] Fixture Show S2 - 0${episode - 6}.1080p.mkv`,
    true,
  );
  const familyB = urlCandidate(
    episode,
    alternate,
    season === 1
      ? `[Group${alternate}] Fixture Show - 0${episode}.1080p.mkv`
      : `[Group${alternate}] Fixture Show S2 - 0${episode - 6}.1080p.mkv`,
    false,
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
        { name: "subtitles", types: ["series"] },
      ],
    });
  }
  const subtitlePrefix = `${addonBase}/subtitles/series/`;
  if (
    url.pathname.startsWith(subtitlePrefix) &&
    url.pathname.endsWith(".json")
  ) {
    const tail = decodeURIComponent(
      url.pathname.slice(subtitlePrefix.length, -5),
    );
    const slash = tail.indexOf("/");
    const extra = new URL(
      `http://fixture/?${slash < 0 ? "" : tail.slice(slash + 1)}`,
    ).searchParams;
    const videoId = extra.get("videoID") ?? "";
    const imdb = /^tt1234567:([12]):([1-6])$/.exec(videoId);
    const opaqueOne = /^fixture:opaque:episode:([1-6])$/.exec(videoId);
    const opaqueTwo = /^fixture:opaque:season2:episode:([1-6])$/.exec(videoId);
    const sourceEpisode = imdb?.[2] ?? opaqueOne?.[1] ?? opaqueTwo?.[1];
    if (sourceEpisode === undefined)
      return json(response, 200, { subtitles: [] });
    const season = Number(imdb?.[1] ?? (opaqueTwo === null ? 1 : 2));
    const episode = Number(sourceEpisode) + (season - 1) * 6;
    counts.subtitleRequests += 1;
    return json(response, 200, {
      subtitles: [
        {
          id: "french-full",
          url: `${subtitleOrigin}/episode${episode}.fra.vtt?resource=subtitle-resource-secret-${episode}`,
          lang: "fra",
        },
        {
          id: "english-full",
          url: `${subtitleOrigin}/episode${episode}.eng.srt?signed=subtitle-secret-${episode}`,
          lang: "ENG",
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
    const imdbMatch = /^tt1234567:([12]):([1-6])$/.exec(videoId);
    const opaqueMatch = /^fixture:opaque:episode:([1-6])$/.exec(videoId);
    const opaqueSeasonTwo = /^fixture:opaque:season2:episode:([1-6])$/.exec(
      videoId,
    );
    const sourceEpisode =
      imdbMatch?.[2] ?? opaqueMatch?.[1] ?? opaqueSeasonTwo?.[1];
    const season = Number(imdbMatch?.[1] ?? (opaqueSeasonTwo === null ? 1 : 2));
    const episodeText =
      sourceEpisode === undefined
        ? undefined
        : String(Number(sourceEpisode) + (season - 1) * 6);
    if (episodeText === undefined) return json(response, 404, { streams: [] });
    const episode = Number(episodeText);
    counts.streamRequests += 1;
    counts.streamByVideoId[videoId] =
      (counts.streamByVideoId[videoId] ?? 0) + 1;
    return json(response, 200, { streams: streamsFor(episode, season) });
  }
  return json(response, 404, { error: "not found" });
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`fixture Stremio addon listening on ${port}\n`);
});
