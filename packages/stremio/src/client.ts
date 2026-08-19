import { parseRuntimeSeconds } from "@animetvcut/core";

import {
  MetadataStremioInvalidResponseError,
  MetadataStremioUnavailableError,
} from "./errors.js";
import {
  parseCatalogResponse,
  parseMetadataManifest,
  parseMetaResponse,
  selectSearchCatalog,
} from "./parser.js";
import type {
  MetadataStremioManifest,
  SourceSeriesMeta,
  StremioCatalogDeclaration,
  StremioMetaPreview,
} from "./types.js";
import {
  deriveStremioResourceUrl,
  parseManifestUrl,
  safeManifestOrigin,
} from "./url.js";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface MetadataStremioConfigInput {
  manifestUrl: string | URL;
  searchCatalogId?: string;
  requestTimeoutMs?: number;
  manifestCacheTtlMs?: number;
  catalogCacheTtlMs?: number;
  metaCacheTtlMs?: number;
}

export interface MetadataStremioStats {
  manifestRequests: number;
  catalogRequests: number;
  metaRequests: number;
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    /^\d+$/.test(declared) &&
    Number(declared) > maximumBytes
  ) {
    await response.body?.cancel();
    throw new MetadataStremioInvalidResponseError(
      "Metadata Stremio response is too large.",
    );
  }
  if (response.body === null) {
    throw new MetadataStremioInvalidResponseError(
      "Metadata Stremio response body is empty.",
    );
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maximumBytes) {
      await response.body.cancel();
      throw new MetadataStremioInvalidResponseError(
        "Metadata Stremio response is too large.",
      );
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new MetadataStremioInvalidResponseError(
      "Metadata Stremio response is not valid JSON.",
    );
  }
}

export class MetadataStremioClient {
  public readonly manifestUrl: URL;
  public readonly requestTimeoutMs: number;
  private manifestCache?: CacheEntry<MetadataStremioManifest>;
  private manifestInFlight?: Promise<MetadataStremioManifest>;
  private readonly catalogCache = new Map<
    string,
    CacheEntry<readonly StremioMetaPreview[]>
  >();
  private readonly metaCache = new Map<string, CacheEntry<SourceSeriesMeta>>();
  private readonly counters: MetadataStremioStats = {
    manifestRequests: 0,
    catalogRequests: 0,
    metaRequests: 0,
  };
  private readonly manifestCacheTtlMs: number;
  private readonly catalogCacheTtlMs: number;
  private readonly metaCacheTtlMs: number;

  public constructor(
    private readonly input: MetadataStremioConfigInput,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.manifestUrl = parseManifestUrl(input.manifestUrl);
    this.requestTimeoutMs = input.requestTimeoutMs ?? 10_000;
    this.manifestCacheTtlMs = input.manifestCacheTtlMs ?? 60 * 60 * 1000;
    this.catalogCacheTtlMs = input.catalogCacheTtlMs ?? 5 * 60 * 1000;
    this.metaCacheTtlMs = input.metaCacheTtlMs ?? 5 * 60 * 1000;
  }

  public get safeOrigin(): string {
    return safeManifestOrigin(this.manifestUrl);
  }

  public get stats(): Readonly<MetadataStremioStats> {
    return { ...this.counters };
  }

  public async getManifest(
    signal?: AbortSignal,
  ): Promise<MetadataStremioManifest> {
    const cached = this.manifestCache;
    if (cached !== undefined && cached.expiresAt > this.now())
      return cached.value;
    // Reuse or create the shared upstream fetch. Do NOT pass caller signal
    // to loadManifest — the shared fetch uses only an internal timeout so
    // that one caller's abort never cancels the upstream request for others.
    let shared = this.manifestInFlight;
    if (shared === undefined) {
      shared = this.loadManifest();
      this.manifestInFlight = shared;
      // Attach cleanup to the shared promise so it only clears when the
      // upstream request actually settles. Use a catch to prevent
      // unhandled rejection warnings when the shared promise rejects but
      // all callers have already detached (aborted).
      void shared
        .finally(() => {
          if (this.manifestInFlight === shared) {
            this.manifestInFlight = undefined;
          }
        })
        .catch(() => {
          // Suppress unhandled rejection if no caller is waiting.
          // The rejection has already been observed by callers who
          // raced against this promise.
        });
    }
    // Every caller independently races its own signal against the shared
    // promise. Caller cancellation stops waiting for that caller only.
    // When the shared promise settles, remove the caller's abort listener
    // to avoid leaving it attached unnecessarily.
    let abortHandler: (() => void) | undefined;
    const promise =
      signal !== undefined
        ? Promise.race([
            shared,
            new Promise<never>((_resolve, reject) => {
              if (signal.aborted) {
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error("The operation was aborted."),
                );
              } else {
                abortHandler = () =>
                  reject(
                    signal.reason instanceof Error
                      ? signal.reason
                      : new Error("The operation was aborted."),
                  );
                signal.addEventListener("abort", abortHandler, {
                  once: true,
                });
              }
            }),
          ])
        : shared;
    try {
      return await promise;
    } finally {
      // Remove the caller's abort listener when this wrapper settles,
      // regardless of whether it was due to abort or the shared promise
      // resolving/rejecting. This prevents leaving listeners attached
      // on signals that outlive this call.
      if (abortHandler !== undefined) {
        signal?.removeEventListener("abort", abortHandler);
      }
    }
  }

  public async getSearchCatalog(
    signal?: AbortSignal,
  ): Promise<StremioCatalogDeclaration> {
    return selectSearchCatalog(
      await this.getManifest(signal),
      this.input.searchCatalogId,
    );
  }

  public async searchSeries(
    query: string,
    skip = 0,
    signal?: AbortSignal,
  ): Promise<readonly StremioMetaPreview[]> {
    const normalized = query.trim();
    if (
      normalized.length === 0 ||
      normalized.length > 256 ||
      !Number.isSafeInteger(skip) ||
      skip < 0 ||
      skip > 10_000
    ) {
      throw new MetadataStremioInvalidResponseError(
        "Metadata catalog search parameters are invalid.",
      );
    }
    const catalog = await this.getSearchCatalog(signal);
    const key = JSON.stringify([catalog.id, normalized, skip]);
    const cached = this.catalogCache.get(key);
    if (cached !== undefined && cached.expiresAt > this.now())
      return cached.value;
    const extras: Record<string, string | number> = { search: normalized };
    if (skip > 0) extras.skip = skip;
    const response = await this.request(
      deriveStremioResourceUrl(
        this.manifestUrl,
        ["catalog", "series", catalog.id],
        extras,
      ),
      "catalog",
      signal,
    );
    const values = parseCatalogResponse(
      await readBoundedJson(response, 2 * 1024 * 1024),
    );
    if (this.catalogCacheTtlMs > 0) {
      this.catalogCache.set(key, {
        value: values,
        expiresAt: this.now() + this.catalogCacheTtlMs,
      });
    }
    return values;
  }

  public async getSeriesMeta(
    sourceId: string,
    signal?: AbortSignal,
  ): Promise<SourceSeriesMeta> {
    if (sourceId.length === 0 || Buffer.byteLength(sourceId, "utf8") > 512) {
      throw new MetadataStremioInvalidResponseError(
        "Metadata series ID is invalid.",
      );
    }
    const cached = this.metaCache.get(sourceId);
    if (cached !== undefined && cached.expiresAt > this.now())
      return cached.value;
    await this.getManifest(signal);
    const response = await this.request(
      deriveStremioResourceUrl(this.manifestUrl, ["meta", "series", sourceId]),
      "meta",
      signal,
    );
    const value = parseMetaResponse(
      await readBoundedJson(response, 4 * 1024 * 1024),
      parseRuntimeSeconds,
    );
    if (value.id !== sourceId) {
      throw new MetadataStremioInvalidResponseError(
        "Metadata Stremio returned a mismatched series ID.",
      );
    }
    if (this.metaCacheTtlMs > 0) {
      this.metaCache.set(sourceId, {
        value,
        expiresAt: this.now() + this.metaCacheTtlMs,
      });
    }
    return value;
  }

  public async checkHealth(): Promise<{
    configured: true;
    reachable: boolean;
    manifestValid: boolean;
    origin: string;
    addonName?: string;
    addonVersion?: string;
    catalogId?: string;
  }> {
    try {
      const manifest = await this.getManifest();
      const catalog = selectSearchCatalog(manifest, this.input.searchCatalogId);
      return {
        configured: true,
        reachable: true,
        manifestValid: true,
        origin: this.safeOrigin,
        addonName: manifest.name,
        addonVersion: manifest.version,
        catalogId: catalog.id,
      };
    } catch (error) {
      return {
        configured: true,
        reachable: !(error instanceof MetadataStremioUnavailableError),
        manifestValid: false,
        origin: this.safeOrigin,
      };
    }
  }

  private async loadManifest(
    signal?: AbortSignal,
  ): Promise<MetadataStremioManifest> {
    const response = await this.request(this.manifestUrl, "manifest", signal);
    const manifest = parseMetadataManifest(
      await readBoundedJson(response, 256 * 1024),
    );
    selectSearchCatalog(manifest, this.input.searchCatalogId);
    if (this.manifestCacheTtlMs > 0) {
      this.manifestCache = {
        value: manifest,
        expiresAt: this.now() + this.manifestCacheTtlMs,
      };
    }
    return manifest;
  }

  private async request(
    url: URL,
    kind: "manifest" | "catalog" | "meta",
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    if (kind === "manifest") this.counters.manifestRequests += 1;
    else if (kind === "catalog") this.counters.catalogRequests += 1;
    else this.counters.metaRequests += 1;
    const startedAt = Date.now();
    // Keep explicit references to the timeout signal so we can classify
    // failures correctly in the catch path.
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal =
      callerSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([callerSignal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { accept: "application/json" },
      });
    } catch {
      const elapsed = Date.now() - startedAt;
      const classification = classifyFetchFailure(callerSignal, timeoutSignal);
      console.error(
        `[stremio] ${kind} request failed origin=${this.safeOrigin} elapsed=${elapsed}ms classification=${classification}`,
      );
      throw new MetadataStremioUnavailableError(
        callerSignal?.aborted === true
          ? "Metadata Stremio request was cancelled."
          : "Metadata Stremio request timed out or failed.",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      const elapsed = Date.now() - startedAt;
      console.error(
        `[stremio] ${kind} request failed origin=${this.safeOrigin} elapsed=${elapsed}ms classification=redirect status=${response.status}`,
      );
      await response.body?.cancel();
      throw new MetadataStremioUnavailableError(
        `Metadata Stremio ${kind} returned an unexpected redirect.`,
      );
    }
    if (!response.ok) {
      const elapsed = Date.now() - startedAt;
      console.error(
        `[stremio] ${kind} request failed origin=${this.safeOrigin} elapsed=${elapsed}ms classification=upstream_error status=${response.status}`,
      );
      await response.body?.cancel();
      throw new MetadataStremioUnavailableError(
        `Metadata Stremio ${kind} failed with HTTP ${response.status}.`,
      );
    }
    return response;
  }
}

/**
 * Classify a fetch rejection based on which signal caused cancellation.
 * Pure helper for deterministic unit testing.
 */
export function classifyFetchFailure(
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): "cancelled" | "timeout" | "network_error" {
  if (callerSignal?.aborted === true) return "cancelled";
  if (timeoutSignal.aborted) return "timeout";
  return "network_error";
}
