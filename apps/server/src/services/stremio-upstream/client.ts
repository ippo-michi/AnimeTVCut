import {
  createStremioUpstreamConfig,
  type StremioUpstreamConfig,
  type StremioUpstreamConfigInput,
} from "./config.js";
import {
  StremioManifestInvalidError,
  StremioStreamResponseInvalidError,
  StremioUpstreamUnavailableError,
} from "./errors.js";
import {
  assertManifestSupportsReference,
  buildStreamResourceUrl,
  buildSubtitleResourceUrl,
  manifestSupportsSubtitles,
  parseStremioManifest,
} from "./manifest.js";
import { manifestOrigin } from "./redaction.js";
import { parseStremioStreamResponse } from "./stream-parser.js";
import { parseStremioSubtitleResponse } from "./subtitle-parser.js";
import type {
  StremioManifest,
  StremioStreamCandidate,
  UpstreamEpisodeReference,
  UpstreamSubtitle,
} from "./types.js";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_STREAM_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SUBTITLE_RESPONSE_BYTES = 2 * 1024 * 1024;

type FetchImplementation = typeof fetch;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface StremioUpstreamRequestStats {
  manifestRequests: number;
  streamRequests: number;
  subtitleRequests?: number;
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  invalidError: (message: string) => Error,
): Promise<unknown> {
  const declaredLength = parseContentLength(
    response.headers.get("content-length"),
  );
  if (declaredLength !== undefined && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw invalidError("response is too large");
  }
  if (response.body === null) throw invalidError("response body is empty");
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > maximumBytes) {
      await response.body.cancel();
      throw invalidError("response is too large");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw invalidError("response is not valid JSON");
  }
}

export class StremioUpstreamClient {
  public readonly config: StremioUpstreamConfig;
  private manifestCache?: CacheEntry<StremioManifest>;
  private manifestInFlight?: Promise<StremioManifest>;
  private readonly streamCache = new Map<
    string,
    CacheEntry<readonly StremioStreamCandidate[]>
  >();
  private readonly counters: {
    manifestRequests: number;
    streamRequests: number;
    subtitleRequests: number;
  } = {
    manifestRequests: 0,
    streamRequests: 0,
    subtitleRequests: 0,
  };

  public constructor(
    input: StremioUpstreamConfigInput,
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.config = createStremioUpstreamConfig(input);
  }

  public get stats(): Readonly<StremioUpstreamRequestStats> {
    return {
      manifestRequests: this.counters.manifestRequests,
      streamRequests: this.counters.streamRequests,
      ...(this.counters.subtitleRequests === 0
        ? {}
        : { subtitleRequests: this.counters.subtitleRequests }),
    };
  }

  public clearStreamCache(): void {
    this.streamCache.clear();
  }

  public get safeOrigin(): string {
    return manifestOrigin(this.config.manifestUrl);
  }

  public async getManifest(signal?: AbortSignal): Promise<StremioManifest> {
    const cached = this.manifestCache;
    if (cached !== undefined && cached.expiresAt > this.now())
      return cached.value;
    if (this.manifestInFlight !== undefined) return this.manifestInFlight;
    const loading = this.fetchManifest(signal);
    this.manifestInFlight = loading;
    try {
      return await loading;
    } finally {
      if (this.manifestInFlight === loading) this.manifestInFlight = undefined;
    }
  }

  public async getStreams(
    reference: UpstreamEpisodeReference,
    signal?: AbortSignal,
  ): Promise<readonly StremioStreamCandidate[]> {
    const manifest = await this.getManifest(signal);
    assertManifestSupportsReference(manifest, reference);
    const cacheKey = JSON.stringify([reference.type, reference.videoId]);
    const cached = this.streamCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > this.now())
      return cached.value;

    const resourceUrl = buildStreamResourceUrl(
      this.config.manifestUrl,
      reference,
    );
    const response = await this.request(resourceUrl, "stream", signal);
    this.requireSuccessfulResponse(response, "stream");
    const body = await readBoundedJson(
      response,
      MAX_STREAM_RESPONSE_BYTES,
      (reason) =>
        new StremioStreamResponseInvalidError(
          `Upstream Stremio stream ${reason}.`,
        ),
    );
    const candidates = parseStremioStreamResponse(body);
    // AIOStreams can briefly return a valid JSON response containing only
    // placeholder/unsupported entries while providers finish resolving. Do
    // not turn that transient state into a cache hit; the resolver can retry
    // the same episode and obtain the usable URL candidates on the next pass.
    if (
      this.config.streamCacheTtlMs > 0 &&
      candidates.some((candidate) => candidate.kind === "url")
    ) {
      this.streamCache.set(cacheKey, {
        value: candidates,
        expiresAt: this.now() + this.config.streamCacheTtlMs,
      });
    }
    return candidates;
  }

  public async checkHealth(): Promise<{
    configured: true;
    reachable: boolean;
    manifestValid: boolean;
    origin: string;
    addonName?: string;
    addonVersion?: string;
  }> {
    try {
      const manifest = await this.getManifest();
      return {
        configured: true,
        reachable: true,
        manifestValid: true,
        origin: this.safeOrigin,
        addonName: manifest.name,
        addonVersion: manifest.version,
      };
    } catch (error) {
      return {
        configured: true,
        reachable: !(error instanceof StremioUpstreamUnavailableError),
        manifestValid: false,
        origin: this.safeOrigin,
      };
    }
  }

  public async getSubtitles(
    reference: UpstreamEpisodeReference,
    videoHash: string,
    videoSize?: number,
    signal?: AbortSignal,
  ): Promise<readonly UpstreamSubtitle[]> {
    const manifest = await this.getManifest(signal);
    if (!manifestSupportsSubtitles(manifest, reference)) return [];
    const url = buildSubtitleResourceUrl(
      this.config.manifestUrl,
      reference,
      videoHash,
      videoSize,
    );
    const response = await this.request(url, "subtitles", signal);
    this.requireSuccessfulResponse(response, "subtitles");
    const body = await readBoundedJson(
      response,
      MAX_SUBTITLE_RESPONSE_BYTES,
      (reason) =>
        new StremioStreamResponseInvalidError(
          `Upstream Stremio subtitle response ${reason}.`,
        ),
    );
    try {
      return parseStremioSubtitleResponse(body);
    } catch {
      throw new StremioStreamResponseInvalidError(
        "Upstream Stremio subtitle response is invalid.",
      );
    }
  }

  private async fetchManifest(signal?: AbortSignal): Promise<StremioManifest> {
    const response = await this.request(
      this.config.manifestUrl,
      "manifest",
      signal,
    );
    this.requireSuccessfulResponse(response, "manifest");
    const body = await readBoundedJson(
      response,
      MAX_MANIFEST_BYTES,
      (reason) =>
        new StremioManifestInvalidError(`Upstream Stremio manifest ${reason}.`),
    );
    const manifest = parseStremioManifest(body);
    if (this.config.manifestCacheTtlMs > 0) {
      this.manifestCache = {
        value: manifest,
        expiresAt: this.now() + this.config.manifestCacheTtlMs,
      };
    }
    return manifest;
  }

  private async request(
    url: URL,
    kind: "manifest" | "stream" | "subtitles",
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    if (kind === "manifest") this.counters.manifestRequests += 1;
    else if (kind === "stream") this.counters.streamRequests += 1;
    else this.counters.subtitleRequests += 1;
    const timeoutSignal = AbortSignal.timeout(this.config.requestTimeoutMs);
    const signal =
      callerSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([callerSignal, timeoutSignal]);
    try {
      return await this.fetchImplementation(url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { accept: "application/json" },
      });
    } catch {
      throw new StremioUpstreamUnavailableError(
        callerSignal?.aborted === true
          ? "Upstream Stremio request was cancelled."
          : "Upstream Stremio request timed out or failed.",
      );
    }
  }

  private requireSuccessfulResponse(
    response: Response,
    kind: "manifest" | "stream" | "subtitles",
  ): void {
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel();
      throw new StremioUpstreamUnavailableError(
        `Upstream Stremio ${kind} request returned an unexpected redirect.`,
      );
    }
    if (!response.ok) {
      void response.body?.cancel();
      throw new StremioUpstreamUnavailableError(
        `Upstream Stremio ${kind} request failed with HTTP ${response.status}.`,
      );
    }
  }
}
