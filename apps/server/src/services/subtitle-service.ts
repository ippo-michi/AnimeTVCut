import { createHash } from "node:crypto";

import {
  composeAss,
  composeWebVtt,
  decodeSubtitleBytes,
  deduplicateSubtitles,
  detectSubtitleFormat,
  mapSubtitleEvents,
  matchSubtitleFamilies,
  parseAss,
  parseSrt,
  parseWebVtt,
  type DiscoveredSubtitle,
  type ParsedAssSubtitle,
  type SubtitleEvent,
} from "@animetvcut/subtitles";

import type {
  CutSessionStore,
  SessionSubtitleTrack,
} from "./cut-session-store.js";
import type { StremioUpstreamClient } from "./stremio-upstream/client.js";
import type { CandidateFamilySelection } from "./stremio-upstream/types.js";
import type { SubtitleConfig } from "./subtitle-config.js";
import { SafeSubtitleFetcher } from "./subtitle-fetcher.js";

export interface PublicSubtitleTrack {
  id: string;
  lang: string;
  extension: "vtt" | "ass";
}

export class SubtitleService {
  private readonly fetcher: SafeSubtitleFetcher;
  public constructor(
    private readonly config: SubtitleConfig,
    private readonly sessions: CutSessionStore,
    private readonly upstreamClient?: StremioUpstreamClient,
    fetcher?: SafeSubtitleFetcher,
  ) {
    this.fetcher = fetcher ?? new SafeSubtitleFetcher(config);
  }

  public async discover(
    cutId: string,
    selection: CandidateFamilySelection,
    signal?: AbortSignal,
  ): Promise<readonly PublicSubtitleTrack[]> {
    if (!this.config.enabled) return [];
    const discovered: DiscoveredSubtitle[] = [];
    const counts: Record<string, number> = {};
    for (const episode of selection.episodes) {
      const items = [...(episode.subtitles ?? [])];
      if (
        episode.videoHash !== undefined &&
        this.upstreamClient !== undefined
      ) {
        try {
          items.push(
            ...(await this.upstreamClient.getSubtitles(
              {
                episodeId: episode.episodeId,
                type: episode.upstreamType,
                videoId: episode.upstreamVideoId,
              },
              episode.videoHash,
              episode.videoSize,
              signal,
            )),
          );
        } catch {
          /* best-effort standard subtitle metadata */
        }
      }
      const unique = deduplicateSubtitles(
        items.map((item) => ({ ...item, episodeId: episode.episodeId })),
      );
      counts[episode.episodeId] = unique.length;
      discovered.push(...unique);
    }
    const matched = matchSubtitleFamilies(
      selection.episodes.map((episode) => episode.episodeId),
      discovered,
    );
    const tracks: SessionSubtitleTrack[] = matched.families.map(
      (family, index) => ({
        id: `sub${String(index + 1).padStart(2, "0")}-${createHash("sha256")
          .update(
            `${family.lang}\0${family.sources.map((item) => item.id).join("\0")}`,
          )
          .digest("base64url")
          .slice(0, 8)}`,
        lang: family.lang,
        familyMethod: family.familyMethod,
        outputFormat: family.outputFormat,
        state: "lazy",
        sources: family.sources.map((item) => ({
          episodeId: item.episodeId,
          subtitleId: item.id,
          url: item.url,
          ...(item.formatHint === undefined
            ? {}
            : { formatHint: item.formatHint }),
        })),
      }),
    );
    this.sessions.attachSubtitles(cutId, tracks, {
      discoveredPerEpisode: counts,
      issues: matched.issues,
    });
    return tracks.map((track) => ({
      id: track.id,
      lang: track.lang,
      extension: track.outputFormat === "ass" ? "ass" : "vtt",
    }));
  }

  public publicTracks(cutId: string): readonly PublicSubtitleTrack[] {
    const session = this.sessions.get(cutId);
    if (session === undefined) return [];
    return [...session.subtitleTracks.values()].map((track) => ({
      id: track.id,
      lang: track.lang,
      extension: track.outputFormat === "ass" ? "ass" : "vtt",
    }));
  }

  public diagnostics(cutId: string): unknown {
    const session = this.sessions.get(cutId);
    if (session === undefined) return undefined;
    return {
      discoveredPerEpisode: session.subtitleDiagnostics.discoveredPerEpisode,
      issues: session.subtitleDiagnostics.issues,
      tracks: [...session.subtitleTracks.values()].map((track) => ({
        id: track.id,
        lang: track.lang,
        familyMethod: track.familyMethod,
        episodes: track.sources.length,
        outputFormat: track.outputFormat,
        state: track.state,
        ...(track.cueCount === undefined ? {} : { cueCount: track.cueCount }),
        ...(track.errorCode === undefined
          ? {}
          : { errorCode: track.errorCode }),
      })),
    };
  }

  public async compose(
    cutId: string,
    trackId: string,
    extension: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    const session = this.sessions.get(cutId),
      track = session?.subtitleTracks.get(trackId);
    if (
      session === undefined ||
      track === undefined ||
      extension !== (track.outputFormat === "ass" ? "ass" : "vtt")
    )
      return undefined;
    if (track.cached !== undefined) {
      this.sessions.touch(cutId);
      return {
        bytes: track.cached,
        contentType:
          track.outputFormat === "ass"
            ? "text/x-ssa; charset=utf-8"
            : "text/vtt; charset=utf-8",
      };
    }
    const inFlight =
      track.inFlight ?? this.startComposition(track, session.pieces);
    const bytes = await this.waitForComposition(track, inFlight, signal);
    this.sessions.touch(cutId);
    return {
      bytes,
      contentType:
        track.outputFormat === "ass"
          ? "text/x-ssa; charset=utf-8"
          : "text/vtt; charset=utf-8",
    };
  }

  private startComposition(
    track: SessionSubtitleTrack,
    pieces: Parameters<typeof mapSubtitleEvents>[1],
  ): Promise<Uint8Array> {
    track.state = "composing";
    track.abortController = new AbortController();
    track.waiters = 0;
    const promise = this.composeTrack(
      track,
      pieces,
      track.abortController.signal,
    )
      .then(({ bytes, cueCount }) => {
        if (bytes.byteLength > this.config.maxGeneratedBytes)
          throw new Error("generated_subtitle_too_large");
        track.cached = bytes;
        track.cueCount = cueCount;
        track.state = "ready";
        track.errorCode = undefined;
        return bytes;
      })
      .catch((error: unknown) => {
        track.state = "failed";
        track.errorCode =
          error instanceof Error
            ? error.message
            : "subtitle_composition_failed";
        throw error;
      })
      .finally(() => {
        track.inFlight = undefined;
        track.abortController = undefined;
        track.waiters = undefined;
      });
    track.inFlight = promise;
    return promise;
  }

  private waitForComposition(
    track: SessionSubtitleTrack,
    composition: Promise<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    track.waiters = (track.waiters ?? 0) + 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result: { value: Uint8Array } | { error: unknown }) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        track.waiters = Math.max(0, (track.waiters ?? 1) - 1);
        if (track.waiters === 0 && track.state === "composing")
          track.abortController?.abort();
        if ("error" in result)
          reject(
            result.error instanceof Error
              ? result.error
              : new Error("subtitle_composition_failed"),
          );
        else resolve(result.value);
      };
      const cancel = () => finish({ error: new Error("cancelled") });
      if (signal?.aborted === true) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      void composition.then(
        (value) => finish({ value }),
        (error: unknown) => finish({ error }),
      );
    });
  }

  private async composeTrack(
    track: SessionSubtitleTrack,
    pieces: Parameters<typeof mapSubtitleEvents>[1],
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; cueCount: number }> {
    const parsedAss: ParsedAssSubtitle[] = [],
      events: SubtitleEvent[] = [];
    const fetchedByUrl = new Map<
      string,
      ReturnType<SafeSubtitleFetcher["fetch"]>
    >();
    const results = new Array<{
      ass?: ParsedAssSubtitle;
      events: readonly SubtitleEvent[];
    }>(track.sources.length);
    let nextIndex = 0;
    const workers = Array.from(
      {
        length: Math.min(
          this.config.composeFetchConcurrency,
          track.sources.length,
        ),
      },
      async () => {
        while (nextIndex < track.sources.length) {
          const episodeOrder = nextIndex++;
          const source = track.sources[episodeOrder]!;
          let request = fetchedByUrl.get(source.url);
          if (request === undefined) {
            request = this.fetcher.fetch(source.url, signal);
            fetchedByUrl.set(source.url, request);
          }
          const fetched = await request;
          const format = detectSubtitleFormat(
            fetched.bytes,
            fetched.contentType,
            source.formatHint,
          );
          if (format === undefined) throw new Error("unsupported_format");
          if (
            (track.outputFormat === "ass") !==
            (format === "ass" || format === "ssa")
          )
            throw new Error("format_family_mismatch");
          const text = decodeSubtitleBytes(fetched.bytes);
          if (format === "srt")
            results[episodeOrder] = {
              events: parseSrt(text, source.episodeId, episodeOrder).events,
            };
          else if (format === "webvtt")
            results[episodeOrder] = {
              events: parseWebVtt(text, source.episodeId, episodeOrder).events,
            };
          else {
            const ass = parseAss(text, source.episodeId, episodeOrder, format);
            results[episodeOrder] = { ass, events: ass.events };
          }
        }
      },
    );
    await Promise.all(workers);
    for (const result of results) {
      if (result.ass !== undefined) parsedAss.push(result.ass);
      events.push(...result.events);
    }
    const mapped = mapSubtitleEvents(events, pieces);
    const text =
      track.outputFormat === "ass"
        ? composeAss(parsedAss, mapped)
        : composeWebVtt(mapped);
    return { bytes: new TextEncoder().encode(text), cueCount: mapped.length };
  }
}
