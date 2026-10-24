import type { ComposedResource, HlsVodPlaylist } from "@animetvcut/hls";
import { WorkQueue } from "@animetvcut/core";

import type {
  HlsResolvedResource,
  HlsSourceLoader,
  HttpMediaSource,
  LazyMediaResource,
  MediaInputSource,
} from "./hls-source-loader.js";
import {
  MediaFlowAuthenticationError,
  MediaFlowSourceError,
  MediaFlowUnavailableError,
} from "./mediaflow/errors.js";
import type { StremioUpstreamClient } from "./stremio-upstream/client.js";

function timeline(playlist: HlsVodPlaylist): string {
  return JSON.stringify([
    playlist.duration,
    playlist.segments.map((segment) => [
      segment.start,
      segment.end,
      segment.mediaStart,
      segment.mediaEnd,
      segment.mediaFormat,
      segment.map?.mediaFormat,
      segment.map?.byteRange,
    ]),
  ]);
}

/** Refresh URLs only after both release identity and the complete normalized timeline match. */
export class RecoverableSourceLoader implements HlsSourceLoader {
  private readonly resources = new WeakMap<
    HttpMediaSource,
    Set<ComposedResource>
  >();
  private readonly refreshes = new WeakMap<HttpMediaSource, Promise<void>>();
  private readonly lastAttempts = new WeakMap<HttpMediaSource, number>();
  private readonly shutdown = new AbortController();
  private readonly refreshQueue = new WorkQueue(2);

  public constructor(
    private readonly base: HlsSourceLoader,
    private readonly upstream?: StremioUpstreamClient,
    private readonly changed?: () => void,
  ) {}

  public close(): void {
    this.shutdown.abort();
  }

  public async loadPlaylist(
    source: MediaInputSource,
    signal?: AbortSignal,
  ): Promise<HlsVodPlaylist> {
    const playlist = await this.base.loadPlaylist(source, signal);
    if (source.kind === "http_media" && source.recovery !== undefined)
      source.recovery.playlist = playlist;
    return playlist;
  }

  public createResource(resolved: HlsResolvedResource): LazyMediaResource {
    const { source, resource } = resolved;
    if (source.kind === "http_media") {
      const resources =
        this.resources.get(source) ?? new Set<ComposedResource>();
      resources.add(resource);
      this.resources.set(source, resources);
    }
    const initial = this.base.createResource(resolved);
    return {
      contentType: initial.contentType,
      open: async (range, signal) => {
        const attemptedUri = resource.absoluteUri;
        try {
          return await this.base.createResource(resolved).open(range, signal);
        } catch (error) {
          signal?.throwIfAborted();
          if (resource.absoluteUri !== attemptedUri)
            return this.base.createResource(resolved).open(range, signal);
          if (
            source.kind !== "http_media" ||
            source.recovery?.playlist === undefined ||
            this.upstream === undefined ||
            !(
              error instanceof MediaFlowSourceError ||
              error instanceof MediaFlowUnavailableError ||
              error instanceof MediaFlowAuthenticationError
            )
          )
            throw error;
          let refresh = this.refreshes.get(source);
          if (refresh === undefined) {
            if (Date.now() - (this.lastAttempts.get(source) ?? 0) < 30_000)
              throw error;
            this.lastAttempts.set(source, Date.now());
            const refreshSignal = AbortSignal.any([
              this.shutdown.signal,
              AbortSignal.timeout(60_000),
            ]);
            refresh = this.refreshQueue.run(
              () => this.refresh(source, refreshSignal),
              refreshSignal,
            );
            this.refreshes.set(source, refresh);
            const shared = refresh;
            void shared
              .finally(() => {
                if (this.refreshes.get(source) === shared)
                  this.refreshes.delete(source);
              })
              .catch(() => {});
          }
          // The refresh has its own deadline; a disconnected viewer only stops its wait.
          let abort: (() => void) | undefined;
          try {
            await (signal === undefined
              ? refresh
              : Promise.race([
                  refresh,
                  new Promise<never>((_resolve, reject) => {
                    abort = () =>
                      reject(
                        signal.reason instanceof Error
                          ? signal.reason
                          : new Error("Media request cancelled."),
                      );
                    if (signal.aborted) abort();
                    else
                      signal.addEventListener("abort", abort, { once: true });
                  }),
                ]));
          } finally {
            if (abort !== undefined)
              signal?.removeEventListener("abort", abort);
          }
          signal?.throwIfAborted();
          return this.base.createResource(resolved).open(range, signal);
        }
      },
    };
  }

  private async refresh(
    source: HttpMediaSource,
    signal: AbortSignal,
  ): Promise<void> {
    const identity = source.recovery!;
    if (
      !identity.filename ||
      (!identity.videoHash &&
        !(identity.videoSize !== undefined && identity.videoSize > 0))
    )
      throw new MediaFlowSourceError(
        "Source expiry recovery requires a verified release identity.",
      );
    const candidates = await this.upstream!.getStreams(
      {
        episodeId: source.episodeId,
        type: identity.type,
        videoId: identity.videoId,
      },
      signal,
      true,
    );
    const candidate = candidates.find(
      (candidate) =>
        candidate.kind === "url" &&
        candidate.filename === identity.filename &&
        (identity.videoSize === undefined ||
          candidate.videoSize === identity.videoSize) &&
        (identity.videoHash === undefined ||
          candidate.videoHash === identity.videoHash),
    );
    if (candidate?.kind !== "url")
      throw new MediaFlowSourceError(
        "The original media release is no longer available.",
      );
    const replacement: HttpMediaSource = {
      ...source,
      url: candidate.url,
      headers: candidate.requestHeaders,
    };
    const playlist = await this.base.loadPlaylist(replacement, signal);
    const previous = identity.playlist!;
    if (timeline(previous) !== timeline(playlist))
      throw new MediaFlowSourceError(
        "Refreshed media does not match the cut timeline.",
      );
    const urls = new Map<string, string>();
    previous.segments.forEach((segment, index) => {
      const next = playlist.segments[index]!;
      urls.set(segment.absoluteUri, next.absoluteUri);
      if (segment.map && next.map)
        urls.set(segment.map.absoluteUri, next.map.absoluteUri);
    });
    const resources = [...(this.resources.get(source) ?? [])];
    if (resources.some((resource) => !urls.has(resource.absoluteUri)))
      throw new MediaFlowSourceError(
        "Refreshed media is missing a cut resource.",
      );
    for (const resource of resources)
      resource.absoluteUri = urls.get(resource.absoluteUri)!;
    source.url = candidate.url;
    source.headers = candidate.requestHeaders;
    identity.playlist = playlist;
    this.changed?.();
  }
}
