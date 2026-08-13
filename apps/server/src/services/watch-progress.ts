import {
  deriveStremioResourceUrl,
  type MetadataStremioClient,
  type MetadataStremioManifest,
} from "@animetvcut/stremio";

import type { CutSession, SessionResource } from "./cut-session-store.js";

export type EpisodeWatchReportResult = "triggered" | "unsupported" | "failed";

export interface EpisodeWatchProgressReporter {
  reportEpisodeWatched(
    sourceEpisodeId: string,
  ): Promise<EpisodeWatchReportResult>;
}

function isAiometadataManifest(manifest: MetadataStremioManifest): boolean {
  const identity = `${manifest.id}\0${manifest.name}`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return (
    identity.includes("aiometadata") && manifest.resources.includes("subtitles")
  );
}

/**
 * AIOMetadata uses its standard Stremio subtitles resource as a best-effort
 * playback trigger. This adapter deliberately keeps that implementation detail
 * isolated from timeline and media composition code.
 */
export class AiometadataWatchProgressReporter implements EpisodeWatchProgressReporter {
  private supported?: boolean;

  public constructor(
    private readonly metadataClient: MetadataStremioClient,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly requestTimeoutMs = metadataClient.requestTimeoutMs,
  ) {
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs <= 0 ||
      requestTimeoutMs > 120_000
    )
      throw new Error(
        "AIOMetadata watch-progress timeout must be between 1 and 120000 milliseconds.",
      );
  }

  public async reportEpisodeWatched(
    sourceEpisodeId: string,
  ): Promise<EpisodeWatchReportResult> {
    if (
      sourceEpisodeId.length === 0 ||
      Buffer.byteLength(sourceEpisodeId, "utf8") > 1024
    )
      return "unsupported";

    const supported = await this.isSupported();
    if (supported === false) return "unsupported";
    if (supported === undefined) return "failed";

    const resourceUrl = deriveStremioResourceUrl(
      this.metadataClient.manifestUrl,
      ["subtitles", "series", sourceEpisodeId],
    );
    try {
      const response = await this.fetchImplementation(resourceUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: { accept: "application/json" },
      });
      if (!response.ok || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel();
        return "failed";
      }
      await response.body?.cancel();
      return "triggered";
    } catch {
      return "failed";
    }
  }

  private async isSupported(): Promise<boolean | undefined> {
    if (this.supported !== undefined) return this.supported;
    try {
      const manifest = await this.metadataClient.getManifest();
      this.supported = isAiometadataManifest(manifest);
      return this.supported;
    } catch {
      return undefined;
    }
  }
}

export class CutWatchProgressTracker {
  public constructor(private readonly reporter: EpisodeWatchProgressReporter) {}

  public sourceEpisodeCompleted(
    session: CutSession,
    resource: SessionResource,
  ): void {
    const state = session.watchProgress;
    if (
      state === undefined ||
      state.unavailable ||
      resource.kind !== "segment" ||
      !resource.completesSourceEpisode ||
      !state.eligibleSourceEpisodeIds.has(resource.sourceEpisodeId) ||
      state.triggeredSourceEpisodeIds.has(resource.sourceEpisodeId) ||
      state.inFlightSourceEpisodeIds.has(resource.sourceEpisodeId)
    )
      return;

    state.inFlightSourceEpisodeIds.add(resource.sourceEpisodeId);
    void this.reporter
      .reportEpisodeWatched(resource.sourceEpisodeId)
      .then((result) => {
        if (result === "triggered")
          state.triggeredSourceEpisodeIds.add(resource.sourceEpisodeId);
        else if (result === "unsupported") state.unavailable = true;
      })
      .catch(() => {
        // Progress reporting is best-effort and must never affect playback.
      })
      .finally(() => {
        state.inFlightSourceEpisodeIds.delete(resource.sourceEpisodeId);
      });
  }
}
