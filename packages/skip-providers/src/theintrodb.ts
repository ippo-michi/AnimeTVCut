import { checkProviderReachable, fetchBoundedJson } from "./http.js";
import type {
  SkipProviderResult,
  SkipSegment,
  SkipSegmentProvider,
  SkipSegmentRequest,
  SkipSegmentType,
  UnsafeSkipReason,
} from "./models.js";
import {
  isRecord,
  normalizedBoundedSegment,
  optionalFiniteNumber,
} from "./provider-utils.js";

const DEFAULT_BASE_URL = "https://api.theintrodb.org/v3";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60_000;
const MAXIMUM_RESPONSE_BYTES = 512 * 1024;

export interface TheIntroDbProviderOptions {
  baseUrl?: string | URL;
  requestTimeoutMs?: number;
  cacheTtlMs?: number;
  minimumConfidence?: number;
  fetchImplementation?: typeof fetch;
}

interface CacheEntry {
  expiresAt: number;
  result: SkipProviderResult;
}

const TYPE_MAP = {
  intro: "opening",
  recap: "recap",
  credits: "ending",
  preview: "preview",
} as const satisfies Record<string, SkipSegmentType>;

function validBaseUrl(value: string | URL): URL {
  const url = new URL(value.toString());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("INTRODB_BASE_URL must use HTTP or HTTPS.");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error(
      "INTRODB_BASE_URL must not contain credentials or a fragment.",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  return url;
}

function cacheKey(request: SkipSegmentRequest): string {
  const imdb = request.identity.imdb!;
  return `${imdb.id}:${imdb.season}:${imdb.episode}:${request.durationSeconds.toFixed(3)}`;
}

function providerResult(
  segments: readonly SkipSegment[],
  warnings: readonly string[],
): SkipProviderResult {
  return {
    provider: "theintrodb",
    status: segments.length === 0 ? "not_found" : "found",
    segments,
    warnings,
  };
}

export class TheIntroDbProvider implements SkipSegmentProvider {
  public readonly name = "theintrodb";
  public readonly priority = 20;
  public readonly enabled = true;
  public readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly minimumConfidence?: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly cache = new Map<string, CacheEntry>();

  public constructor(options: TheIntroDbProviderOptions = {}) {
    this.baseUrl = validBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.minimumConfidence = options.minimumConfidence;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("INTRODB_REQUEST_TIMEOUT_MS must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.cacheTtlMs) || this.cacheTtlMs < 0) {
      throw new Error("TheIntroDB cache TTL must be a non-negative integer.");
    }
    if (
      this.minimumConfidence !== undefined &&
      !Number.isFinite(this.minimumConfidence)
    ) {
      throw new Error("INTRODB_MIN_CONFIDENCE must be finite when configured.");
    }
  }

  public supports(identity: SkipSegmentRequest["identity"]): boolean {
    return identity.imdb !== undefined;
  }

  public buildLookupUrl(request: SkipSegmentRequest): URL {
    const imdb = request.identity.imdb;
    if (imdb === undefined)
      throw new Error("TheIntroDB requires IMDb identity.");
    const url = new URL(`${this.baseUrl.pathname}/media`, this.baseUrl);
    url.searchParams.set("imdb_id", imdb.id);
    url.searchParams.set("season", String(imdb.season));
    url.searchParams.set("episode", String(imdb.episode));
    url.searchParams.set(
      "duration_ms",
      String(Math.round(request.durationSeconds * 1000)),
    );
    return url;
  }

  public async getSegments(
    request: SkipSegmentRequest,
  ): Promise<SkipProviderResult> {
    if (!this.supports(request.identity)) {
      return {
        provider: this.name,
        status: "unsupported_identity",
        segments: [],
        warnings: [],
      };
    }
    const key = cacheKey(request);
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.result;
    }
    const response = await fetchBoundedJson(
      this.buildLookupUrl(request),
      {
        timeoutMs: this.timeoutMs,
        maximumBytes: MAXIMUM_RESPONSE_BYTES,
        fetchImplementation: this.fetchImplementation,
      },
      request.signal,
    );
    const result =
      response.status === 404
        ? providerResult([], [])
        : this.parseResponse(response.body, request.durationSeconds);
    if (this.cacheTtlMs > 0) {
      this.cache.set(key, {
        result,
        expiresAt: Date.now() + this.cacheTtlMs,
      });
    }
    return result;
  }

  public async checkHealth(): Promise<boolean> {
    return checkProviderReachable(
      this.baseUrl,
      this.timeoutMs,
      this.fetchImplementation,
    );
  }

  private parseResponse(
    body: unknown,
    durationSeconds: number,
  ): SkipProviderResult {
    if (!isRecord(body))
      throw new Error("TheIntroDB returned an invalid response.");
    const segments: SkipSegment[] = [];
    const warnings: string[] = [];
    for (const [sourceType, type] of Object.entries(TYPE_MAP)) {
      const entries = body[sourceType];
      if (entries === undefined) continue;
      if (!Array.isArray(entries)) {
        warnings.push(`TheIntroDB ignored malformed ${sourceType} data.`);
        continue;
      }
      for (const entry of entries) {
        if (!isRecord(entry)) {
          warnings.push(
            `TheIntroDB ignored a malformed ${sourceType} segment.`,
          );
          continue;
        }
        const rawStart = entry.start_ms;
        const rawEnd = entry.end_ms;
        const start =
          rawStart === null &&
          (sourceType === "intro" || sourceType === "recap")
            ? 0
            : optionalFiniteNumber(rawStart);
        const confidence = optionalFiniteNumber(entry.confidence);
        const submissionCount = optionalFiniteNumber(entry.submission_count);
        if (start === undefined) {
          warnings.push(`TheIntroDB ignored a malformed ${sourceType} start.`);
          continue;
        }
        if (rawEnd === null) {
          // Emit open-ended diagnostics for intro, credits, and preview.
          // Recap is also emitted as open-ended (remains unsafe).
          segments.push({
            type,
            start: start / 1000,
            end: null,
            provider: this.name,
            sourceType,
            automaticRemoval: false,
            unsafeReason: "open_ended",
            ...(confidence === undefined ? {} : { confidence }),
            ...(submissionCount === undefined ? {} : { submissionCount }),
          });
          continue;
        }
        const end = optionalFiniteNumber(rawEnd);
        if (end === undefined) {
          warnings.push(`TheIntroDB ignored a malformed ${sourceType} end.`);
          continue;
        }
        // The current API uses zero-length values to mean that no segment exists.
        if (start === 0 && end === 0) continue;
        let unsafeReason: UnsafeSkipReason | undefined;
        if (
          this.minimumConfidence !== undefined &&
          confidence !== undefined &&
          confidence < this.minimumConfidence
        ) {
          unsafeReason = "low_confidence";
        }
        segments.push(
          normalizedBoundedSegment({
            type,
            start: start / 1000,
            end: end / 1000,
            durationSeconds,
            provider: this.name,
            sourceType,
            ...(confidence === undefined ? {} : { confidence }),
            ...(submissionCount === undefined ? {} : { submissionCount }),
            ...(unsafeReason === undefined ? {} : { unsafeReason }),
          }),
        );
      }
    }
    return providerResult(segments, warnings);
  }
}
