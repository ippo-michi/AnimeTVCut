import { StremioStreamResponseInvalidError } from "./errors.js";
import type {
  StremioStreamCandidate,
  UnsupportedStreamCandidate,
  UrlStreamCandidate,
} from "./types.js";

export const MAX_STREAM_CANDIDATES = 200;
const MAX_URL_LENGTH = 16_384;
const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 4_096;
const MAX_FILENAME_LENGTH = 1_024;
const MAX_BINGE_GROUP_LENGTH = 512;
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_HEADER_VALUE_LENGTH = 8_192;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DANGEROUS_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "proxy-authorization",
  "proxy-connection",
  "upgrade",
  "te",
  "trailer",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedOptionalString(
  value: unknown,
  maximum: number,
): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum
    ? value
    : undefined;
}

function unsupported(
  rank: number,
  kind: UnsupportedStreamCandidate["kind"],
  reason: string,
  raw: Record<string, unknown>,
): UnsupportedStreamCandidate {
  const name = boundedOptionalString(raw.name, MAX_NAME_LENGTH);
  const description = boundedOptionalString(
    raw.description,
    MAX_DESCRIPTION_LENGTH,
  );
  return {
    rank,
    kind,
    reason,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
  };
}

function parseRequestHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > MAX_HEADER_COUNT) {
    throw new Error("invalid request header collection");
  }
  const headers: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(value)) {
    if (
      name.length > MAX_HEADER_NAME_LENGTH ||
      !HEADER_NAME_PATTERN.test(name) ||
      DANGEROUS_HEADERS.has(name.toLowerCase()) ||
      typeof rawValue !== "string" ||
      rawValue.length > MAX_HEADER_VALUE_LENGTH ||
      rawValue.includes("\r") ||
      rawValue.includes("\n")
    ) {
      throw new Error("unsafe request header");
    }
    headers[name] = rawValue;
  }
  return headers;
}

function classifyCandidate(raw: unknown, rank: number): StremioStreamCandidate {
  if (!isRecord(raw)) {
    return {
      rank,
      kind: "unsupported",
      reason: "Stream entry is not an object.",
    };
  }
  if ("url" in raw) {
    if (
      typeof raw.url !== "string" ||
      raw.url.length === 0 ||
      raw.url.length > MAX_URL_LENGTH
    ) {
      return unsupported(
        rank,
        "unsupported",
        "URL stream has an invalid URL.",
        raw,
      );
    }
    let url: URL;
    try {
      url = new URL(raw.url);
    } catch {
      return unsupported(
        rank,
        "unsupported",
        "URL stream has an invalid URL.",
        raw,
      );
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return unsupported(
        rank,
        "unsupported",
        `URL stream protocol ${url.protocol.replace(":", "")} is unsupported.`,
        raw,
      );
    }
    if (url.username !== "" || url.password !== "") {
      return unsupported(
        rank,
        "unsupported",
        "URL stream contains embedded credentials.",
        raw,
      );
    }
    const hints = isRecord(raw.behaviorHints) ? raw.behaviorHints : {};
    let requestHeaders: Readonly<Record<string, string>>;
    try {
      const proxyHeaders = isRecord(hints.proxyHeaders)
        ? hints.proxyHeaders
        : {};
      requestHeaders = parseRequestHeaders(proxyHeaders.request);
    } catch {
      return unsupported(
        rank,
        "unsupported",
        "URL stream contains unsafe request headers.",
        raw,
      );
    }
    const name = boundedOptionalString(raw.name, MAX_NAME_LENGTH);
    const description = boundedOptionalString(
      raw.description,
      MAX_DESCRIPTION_LENGTH,
    );
    const filename = boundedOptionalString(hints.filename, MAX_FILENAME_LENGTH);
    const bingeGroup = boundedOptionalString(
      hints.bingeGroup,
      MAX_BINGE_GROUP_LENGTH,
    );
    const videoSize =
      typeof hints.videoSize === "number" &&
      Number.isSafeInteger(hints.videoSize) &&
      hints.videoSize >= 0
        ? hints.videoSize
        : undefined;
    const notWebReady =
      typeof hints.notWebReady === "boolean" ? hints.notWebReady : undefined;
    const candidate: UrlStreamCandidate = {
      rank,
      kind: "url",
      url: url.toString(),
      requestHeaders,
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(filename === undefined ? {} : { filename }),
      ...(bingeGroup === undefined ? {} : { bingeGroup }),
      ...(videoSize === undefined ? {} : { videoSize }),
      ...(notWebReady === undefined ? {} : { notWebReady }),
    };
    return candidate;
  }
  if (typeof raw.infoHash === "string") {
    return unsupported(
      rank,
      "torrent",
      "Torrent streams are unsupported in Phase 3.",
      raw,
    );
  }
  if (typeof raw.nzbUrl === "string") {
    return unsupported(
      rank,
      "usenet",
      "Usenet streams are unsupported in Phase 3.",
      raw,
    );
  }
  if (
    Array.isArray(raw.rarUrls) ||
    Array.isArray(raw.zipUrls) ||
    Array.isArray(raw["7zipUrls"]) ||
    Array.isArray(raw.tgzUrls) ||
    Array.isArray(raw.tarUrls)
  ) {
    return unsupported(
      rank,
      "archive",
      "Archive streams are unsupported in Phase 3.",
      raw,
    );
  }
  if (typeof raw.ytId === "string") {
    return unsupported(
      rank,
      "youtube",
      "YouTube streams are unsupported in Phase 3.",
      raw,
    );
  }
  if (typeof raw.externalUrl === "string") {
    return unsupported(
      rank,
      "external",
      "External-player streams are unsupported in Phase 3.",
      raw,
    );
  }
  return unsupported(
    rank,
    "unsupported",
    "Stream has no supported source field.",
    raw,
  );
}

export function parseStremioStreamResponse(
  value: unknown,
): readonly StremioStreamCandidate[] {
  if (!isRecord(value) || !Array.isArray(value.streams)) {
    throw new StremioStreamResponseInvalidError(
      "Upstream Stremio stream response must contain a streams array.",
    );
  }
  if (value.streams.length > MAX_STREAM_CANDIDATES) {
    throw new StremioStreamResponseInvalidError(
      `Upstream Stremio stream response exceeds ${MAX_STREAM_CANDIDATES} candidates.`,
    );
  }
  return value.streams.map(classifyCandidate);
}
