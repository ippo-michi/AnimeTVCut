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

const DEFAULT_BASE_URL = "https://api.aniskip.com/v2";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60_000;
const MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TYPES = ["op", "ed", "mixed-op", "mixed-ed", "recap"] as const;

export interface AniSkipProviderOptions {
  baseUrl?: string | URL;
  requestTimeoutMs?: number;
  cacheTtlMs?: number;
  fetchImplementation?: typeof fetch;
}

interface CacheEntry {
  expiresAt: number;
  result: SkipProviderResult;
}

function validBaseUrl(value: string | URL): URL {
  const url = new URL(value.toString());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ANISKIP_BASE_URL must use HTTP or HTTPS.");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error(
      "ANISKIP_BASE_URL must not contain credentials or a fragment.",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  return url;
}

function mappedType(sourceType: string): SkipSegmentType | undefined {
  if (sourceType === "op" || sourceType === "mixed-op") return "opening";
  if (sourceType === "ed" || sourceType === "mixed-ed") return "ending";
  if (sourceType === "recap") return "recap";
  return undefined;
}

export class AniSkipProvider implements SkipSegmentProvider {
  public readonly name = "aniskip";
  public readonly priority = 30;
  public readonly enabled = true;
  public readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly cache = new Map<string, CacheEntry>();

  public constructor(options: AniSkipProviderOptions = {}) {
    this.baseUrl = validBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("ANISKIP_REQUEST_TIMEOUT_MS must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.cacheTtlMs) || this.cacheTtlMs < 0) {
      throw new Error("AniSkip cache TTL must be a non-negative integer.");
    }
  }

  public supports(identity: SkipSegmentRequest["identity"]): boolean {
    return identity.mal !== undefined;
  }

  public buildLookupUrl(request: SkipSegmentRequest): URL {
    const mal = request.identity.mal;
    if (mal === undefined) throw new Error("AniSkip requires MAL identity.");
    const url = new URL(
      `${this.baseUrl.pathname}/skip-times/${encodeURIComponent(String(mal.animeId))}/${encodeURIComponent(String(mal.episode))}`,
      this.baseUrl,
    );
    for (const type of REQUEST_TYPES) url.searchParams.append("types[]", type);
    url.searchParams.set("episodeLength", "0");
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
    const mal = request.identity.mal!;
    const key = `${mal.animeId}:${mal.episode}:${request.durationSeconds.toFixed(3)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now())
      return cached.result;
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
        ? this.result([], [])
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

  private result(
    segments: readonly SkipSegment[],
    warnings: readonly string[],
  ): SkipProviderResult {
    return {
      provider: this.name,
      status: segments.length === 0 ? "not_found" : "found",
      segments,
      warnings,
    };
  }

  private parseResponse(
    body: unknown,
    durationSeconds: number,
  ): SkipProviderResult {
    if (!isRecord(body) || typeof body.found !== "boolean") {
      throw new Error("AniSkip returned an invalid response.");
    }
    if (!body.found) return this.result([], []);
    if (!Array.isArray(body.results)) {
      throw new Error("AniSkip returned invalid results.");
    }
    const segments: SkipSegment[] = [];
    const warnings: string[] = [];
    for (const entry of body.results) {
      if (!isRecord(entry) || !isRecord(entry.interval)) {
        warnings.push("AniSkip ignored a malformed result.");
        continue;
      }
      const sourceType =
        typeof entry.skipType === "string" ? entry.skipType : "";
      const type = mappedType(sourceType);
      const reportedDuration = optionalFiniteNumber(entry.episodeLength);
      let start = optionalFiniteNumber(entry.interval.startTime);
      let end = optionalFiniteNumber(entry.interval.endTime);
      if (type === undefined || start === undefined || end === undefined) {
        warnings.push("AniSkip ignored a malformed or unknown interval.");
        continue;
      }
      // Scale timestamps when AniSkip episode length differs significantly
      if (
        reportedDuration !== undefined &&
        reportedDuration > 0 &&
        Math.abs(reportedDuration - durationSeconds) > durationSeconds * 0.2
      ) {
        const scale = durationSeconds / reportedDuration;
        start = start * scale;
        end = end * scale;
      }
      let unsafeReason: UnsafeSkipReason | undefined;
      if (sourceType === "mixed-op" || sourceType === "mixed-ed") {
        unsafeReason = "mixed_content";
      }
      segments.push(
        normalizedBoundedSegment({
          type,
          start,
          end,
          durationSeconds,
          provider: this.name,
          sourceType,
          ...(unsafeReason === undefined ? {} : { unsafeReason }),
        }),
      );
    }
    return this.result(segments, warnings);
  }
}
