import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const port = Number.parseInt(process.env.FIXTURE_ORIGIN_PORT ?? "8090", 10);
const mediaRoot = path.resolve(
  process.env.FIXTURE_MEDIA_ROOT ?? "fixtures/media",
);
const requiredToken = process.env.FIXTURE_TEST_TOKEN ?? "animetvcut-test";
const counts = {
  authorized: 0,
  denied: 0,
  ranges: 0,
  redirects: 0,
  primaryFailures: 0,
  bytesServed: 0,
  requests: [],
};
let primaryFailed = false;

function recordRequest(method, pathname, statusCode, range, bytes) {
  counts.requests.push({ method, pathname, statusCode, range, bytes });
  if (counts.requests.length > 2_000) counts.requests.shift();
  counts.bytesServed += bytes;
}

function send(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function parseRange(value, size) {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (match === null) return null;
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= size
  ) {
    return null;
  }
  return { start, end };
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture-origin");
  if (url.pathname === "/health") {
    return send(response, 200, "ok");
  }
  if (url.pathname === "/stats") {
    const body = JSON.stringify(counts);
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    return response.end(body);
  }
  if (url.pathname === "/stats/reset") {
    counts.authorized = 0;
    counts.denied = 0;
    counts.ranges = 0;
    counts.redirects = 0;
    counts.primaryFailures = 0;
    primaryFailed = false;
    counts.bytesServed = 0;
    counts.requests.length = 0;
    return send(response, 200, "ok");
  }
  if (url.pathname === "/cdn/fail-primary") {
    primaryFailed = true;
    return send(response, 200, "ok");
  }
  if (request.headers["x-test-token"] !== requiredToken) {
    counts.denied += 1;
    return send(response, 403, "missing or invalid X-Test-Token");
  }
  counts.authorized += 1;

  const redirectMatch = /^\/redirect\/(episode(?:1[0-2]|[1-9])\.mkv)$/.exec(
    url.pathname,
  );
  if (redirectMatch?.[1] !== undefined) {
    counts.redirects += 1;
    recordRequest(request.method ?? "GET", url.pathname, 302, false, 0);
    response.writeHead(302, {
      location: `/${primaryFailed ? "secondary" : "primary"}/${redirectMatch[1]}`,
    });
    return response.end();
  }

  const episodeMatch =
    /^(?:\/(?:primary|secondary))?\/episode(1[0-2]|[1-9])\.mkv$/.exec(
      url.pathname,
    );
  if (url.pathname.startsWith("/primary/") && primaryFailed) {
    counts.primaryFailures += 1;
    recordRequest(request.method ?? "GET", url.pathname, 503, false, 0);
    return send(response, 503, "primary CDN unavailable");
  }
  const controlMatch =
    /^\/(control-(?:h264-(?:aac\.(?:mp4|mkv)|eac3\.mkv)|hevc-opus\.mkv))$/.exec(
      url.pathname,
    );
  const fileName =
    episodeMatch?.[1] === undefined
      ? controlMatch?.[1]
      : `episode${episodeMatch[1]}.mkv`;
  if (fileName === undefined) return send(response, 404, "not found");
  const filePath = path.join(mediaRoot, fileName);
  let metadata;
  try {
    metadata = statSync(filePath);
  } catch {
    return send(response, 404, "fixture missing");
  }
  const range = parseRange(request.headers.range, metadata.size);
  if (range === null) {
    response.writeHead(416, { "content-range": `bytes */${metadata.size}` });
    return response.end();
  }
  const headers = {
    "accept-ranges": "bytes",
    "content-type": fileName.endsWith(".mp4")
      ? "video/mp4"
      : "video/x-matroska",
  };
  if (range === undefined) {
    const fullHeaders = { ...headers };
    if (!(
      request.method === "HEAD" && url.searchParams.get("head") === "no-size"
    )) {
      fullHeaders["content-length"] = metadata.size;
    }
    response.writeHead(200, fullHeaders);
    recordRequest(
      request.method ?? "GET",
      url.pathname,
      200,
      false,
      request.method === "HEAD" ? 0 : metadata.size,
    );
    if (request.method === "HEAD") return response.end();
    return createReadStream(filePath).pipe(response);
  }
  counts.ranges += 1;
  response.writeHead(206, {
    ...headers,
    "content-length": range.end - range.start + 1,
    "content-range": `bytes ${range.start}-${range.end}/${metadata.size}`,
  });
  recordRequest(
    request.method ?? "GET",
    url.pathname,
    206,
    true,
    request.method === "HEAD" ? 0 : range.end - range.start + 1,
  );
  if (request.method === "HEAD") return response.end();
  return createReadStream(filePath, range).pipe(response);
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`fixture origin listening on ${port}\n`);
});
