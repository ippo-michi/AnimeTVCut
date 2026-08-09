import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import {
  HlsParseError,
  parseHlsVodPlaylist,
  type ComposedResource,
  type HlsVodPlaylist,
} from "@animetvcut/hls";

import type {
  HttpMediaSource,
  LazyMediaResource,
  MediaReadRange,
  OpenedMediaResource,
} from "../hls-source-loader.js";
import {
  createMediaFlowConfig,
  type MediaFlowConfig,
  type MediaFlowConfigInput,
} from "./config.js";
import {
  MediaFlowAuthenticationError,
  MediaFlowConfigurationError,
  MediaFlowInvalidResponseError,
  MediaFlowSourceError,
  MediaFlowUnavailableError,
} from "./errors.js";

const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SAFE_UPSTREAM_RESPONSE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-length",
  "content-range",
] as const;

type FetchImplementation = typeof fetch;
type MediaFlowRequestKind = "health" | "playlist" | "resource";

export interface MediaFlowRequestStats {
  healthRequests: number;
  playlistRequests: number;
  resourceRequests: number;
}

function validateHttpMediaUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MediaFlowSourceError("HTTP media source URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MediaFlowSourceError(
      "HTTP media source URL must use HTTP or HTTPS.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new MediaFlowSourceError(
      "HTTP media source URL must not contain credentials.",
    );
  }
  return url;
}

function appendSourceHeaders(
  url: URL,
  headers: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(headers)) {
    if (
      !HEADER_NAME_PATTERN.test(name) ||
      value.includes("\r") ||
      value.includes("\n")
    ) {
      throw new MediaFlowSourceError(
        "HTTP media source contains an invalid header.",
      );
    }
    url.searchParams.append(`h_${name}`, value);
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function selectSafeHeaders(headers: Headers): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const name of SAFE_UPSTREAM_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) {
      selected[name] = value;
    }
  }
  return selected;
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = parseContentLength(
    response.headers.get("content-length"),
  );
  if (declaredLength !== undefined && declaredLength > MAX_PLAYLIST_BYTES) {
    await response.body?.cancel();
    throw new MediaFlowInvalidResponseError("MediaFlow playlist is too large.");
  }
  if (response.body === null) {
    throw new MediaFlowInvalidResponseError(
      "MediaFlow returned an empty playlist response.",
    );
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > MAX_PLAYLIST_BYTES) {
      await response.body.cancel();
      throw new MediaFlowInvalidResponseError(
        "MediaFlow playlist is too large.",
      );
    }
    chunks.push(chunk);
  }
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export function redactMediaFlowUrl(rawUrl: string | URL): string {
  try {
    const url = new URL(rawUrl.toString());
    return `${url.origin}${url.pathname}${url.search === "" ? "" : "?<redacted>"}`;
  } catch {
    return "<invalid-url>";
  }
}

export class MediaFlowClient {
  public readonly config: MediaFlowConfig;
  private readonly counters: MediaFlowRequestStats = {
    healthRequests: 0,
    playlistRequests: 0,
    resourceRequests: 0,
  };

  public constructor(
    config: MediaFlowConfigInput,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {
    this.config = createMediaFlowConfig(config);
  }

  public get stats(): Readonly<MediaFlowRequestStats> {
    return { ...this.counters };
  }

  public buildTranscodePlaylistUrl(source: HttpMediaSource): URL {
    const sourceUrl = validateHttpMediaUrl(source.url);
    const playlistUrl = new URL(
      "/proxy/transcode/playlist.m3u8",
      this.config.baseUrl,
    );
    playlistUrl.searchParams.set("d", sourceUrl.toString());
    if (this.config.apiPassword !== undefined) {
      playlistUrl.searchParams.set("api_password", this.config.apiPassword);
    }
    appendSourceHeaders(playlistUrl, source.headers ?? {});
    if (playlistUrl.toString().length > 16_384) {
      throw new MediaFlowSourceError("MediaFlow request URL is too large.");
    }
    return playlistUrl;
  }

  public async loadTranscodePlaylist(
    source: HttpMediaSource,
  ): Promise<HlsVodPlaylist> {
    const playlistUrl = this.buildTranscodePlaylistUrl(source);
    const response = await this.request(playlistUrl, "playlist");
    if (!response.ok) {
      await response.body?.cancel();
      this.throwForStatus(response.status);
    }
    const text = await readLimitedText(response);
    let playlist: HlsVodPlaylist;
    try {
      playlist = parseHlsVodPlaylist(text, playlistUrl.toString());
    } catch (error) {
      if (error instanceof HlsParseError) {
        throw new MediaFlowInvalidResponseError(
          "MediaFlow returned an invalid HLS playlist.",
        );
      }
      throw error;
    }
    for (const segment of playlist.segments) {
      this.validateResource(segment.absoluteUri, "segment");
      if (segment.map !== undefined) {
        this.validateResource(segment.map.absoluteUri, "map");
      }
    }
    return playlist;
  }

  public createLazyResource(resource: ComposedResource): LazyMediaResource {
    this.validateResource(resource.absoluteUri, resource.kind);
    return {
      contentType: resource.contentType,
      open: async (range, signal) => this.openResource(resource, range, signal),
    };
  }

  public async isReachable(): Promise<boolean> {
    const healthUrl = new URL("/health", this.config.baseUrl);
    try {
      const response = await this.request(healthUrl, "health");
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  private async openResource(
    resource: ComposedResource,
    range?: MediaReadRange,
    signal?: AbortSignal,
  ): Promise<OpenedMediaResource> {
    const headers = new Headers();
    if (range !== undefined) {
      headers.set("range", `bytes=${range.start}-${range.end ?? ""}`);
    }
    const response = await this.request(resource.absoluteUri, "resource", {
      headers,
      signal,
    });
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel();
      this.throwForStatus(response.status);
    }
    if (response.body === null) {
      throw new MediaFlowInvalidResponseError(
        "MediaFlow returned an empty media response.",
      );
    }
    return {
      statusCode: response.status,
      contentType: resource.contentType,
      ...(parseContentLength(response.headers.get("content-length")) ===
      undefined
        ? {}
        : {
            contentLength: parseContentLength(
              response.headers.get("content-length"),
            ),
          }),
      responseHeaders: selectSafeHeaders(response.headers),
      stream: Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
    };
  }

  private validateResource(
    rawUrl: string,
    kind: ComposedResource["kind"],
  ): void {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new MediaFlowInvalidResponseError(
        "MediaFlow playlist contains an invalid resource URL.",
      );
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new MediaFlowInvalidResponseError(
        "MediaFlow playlist contains an unsupported resource URL.",
      );
    }
    if (url.origin !== this.config.baseUrl.origin) {
      throw new MediaFlowInvalidResponseError(
        "MediaFlow playlist contains a resource from another origin.",
      );
    }
    const expectedPath =
      kind === "map"
        ? "/proxy/transcode/init.mp4"
        : "/proxy/transcode/segment.m4s";
    if (url.pathname !== expectedPath) {
      throw new MediaFlowInvalidResponseError(
        "MediaFlow playlist contains an unapproved resource path.",
      );
    }
  }

  private async request(
    url: string | URL,
    kind: MediaFlowRequestKind,
    options: { headers?: Headers; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.config.requestTimeoutMs);
    const signal =
      options.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([timeoutSignal, options.signal]);
    if (kind === "health") this.counters.healthRequests += 1;
    if (kind === "playlist") this.counters.playlistRequests += 1;
    if (kind === "resource") this.counters.resourceRequests += 1;
    try {
      return await this.fetchImplementation(url, {
        method: "GET",
        headers: options.headers,
        redirect: "manual",
        signal,
      });
    } catch {
      if (options.signal?.aborted === true) {
        throw new MediaFlowUnavailableError("MediaFlow request was cancelled.");
      }
      throw new MediaFlowUnavailableError(
        "MediaFlow request timed out or failed.",
      );
    }
  }

  private throwForStatus(status: number): never {
    if (status === 401 || status === 403) {
      throw new MediaFlowAuthenticationError();
    }
    if (status === 503) {
      throw new MediaFlowSourceError(
        "MediaFlow transcoding is disabled or unavailable.",
      );
    }
    if (status === 404) {
      throw new MediaFlowSourceError(
        "MediaFlow could not access the source media.",
      );
    }
    if (status >= 500) {
      throw new MediaFlowUnavailableError();
    }
    if (status >= 300 && status < 400) {
      throw new MediaFlowInvalidResponseError(
        "MediaFlow returned an unexpected redirect.",
      );
    }
    throw new MediaFlowSourceError(
      "MediaFlow could not normalize the source media.",
    );
  }
}

export function assertMediaFlowConfigured(
  client: MediaFlowClient | undefined,
): asserts client is MediaFlowClient {
  if (client === undefined) {
    throw new MediaFlowConfigurationError("MediaFlow is not configured.");
  }
}
