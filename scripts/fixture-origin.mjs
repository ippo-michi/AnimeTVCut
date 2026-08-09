import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const port = Number.parseInt(process.env.FIXTURE_ORIGIN_PORT ?? "8090", 10);
const mediaRoot = path.resolve(
  process.env.FIXTURE_MEDIA_ROOT ?? "fixtures/media",
);
const requiredToken = process.env.FIXTURE_TEST_TOKEN ?? "animetvcut-test";
const counts = { authorized: 0, denied: 0, ranges: 0 };

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
  if (request.headers["x-test-token"] !== requiredToken) {
    counts.denied += 1;
    return send(response, 403, "missing or invalid X-Test-Token");
  }
  counts.authorized += 1;

  const match = /^\/episode(1[0-2]|[1-9])\.mkv$/.exec(url.pathname);
  if (match?.[1] === undefined) return send(response, 404, "not found");
  const filePath = path.join(mediaRoot, `episode${match[1]}.mkv`);
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
    "content-type": "video/x-matroska",
  };
  if (range === undefined) {
    response.writeHead(200, { ...headers, "content-length": metadata.size });
    if (request.method === "HEAD") return response.end();
    return createReadStream(filePath).pipe(response);
  }
  counts.ranges += 1;
  response.writeHead(206, {
    ...headers,
    "content-length": range.end - range.start + 1,
    "content-range": `bytes ${range.start}-${range.end}/${metadata.size}`,
  });
  if (request.method === "HEAD") return response.end();
  return createReadStream(filePath, range).pipe(response);
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`fixture origin listening on ${port}\n`);
});
