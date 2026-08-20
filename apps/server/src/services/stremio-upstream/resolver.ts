import { selectCandidateFamily } from "./family-selection.js";
import type { StremioUpstreamClient } from "./client.js";
import type {
  CandidateFamilySelection,
  EpisodeCandidateSet,
  EpisodeSourceResolver,
  UpstreamEpisodeReference,
} from "./types.js";
import {
  NoConsistentStreamFamilyError,
  NoUsableStreamsError,
} from "./errors.js";

// Long cuts resolve every episode in a season before a single stream can be
// returned. Two upstream requests made a normal 25-episode season take many
// minutes against AIOStreams; keep the work bounded but use the available
// concurrency so the pack is usable in normal Stremio request lifetimes.
const DEFAULT_MAX_CONCURRENT_EPISODE_REQUESTS = 12;
const DEFAULT_NO_URL_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_FAMILY_SELECTION_RETRY_ATTEMPTS = 1;

interface StremioEpisodeSourceResolverOptions {
  maxConcurrentEpisodeRequests?: number;
  noUrlRetryAttempts?: number;
  retryDelayMs?: number;
}

type RequestSlotRelease = () => void;

interface PendingRequestSlot {
  resolve: (release: RequestSlotRelease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The operation was aborted.");
}

function delayWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  if (signal?.aborted === true) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryableFamilyError(error: unknown): boolean {
  return (
    error instanceof NoConsistentStreamFamilyError ||
    error instanceof NoUsableStreamsError
  );
}

export class StremioEpisodeSourceResolver implements EpisodeSourceResolver {
  private readonly maxConcurrentEpisodeRequests: number;
  private readonly noUrlRetryAttempts: number;
  private readonly retryDelayMs: number;
  private activeEpisodeRequests = 0;
  private readonly pendingRequestSlots: PendingRequestSlot[] = [];

  public constructor(
    public readonly client: StremioUpstreamClient,
    options: StremioEpisodeSourceResolverOptions = {},
  ) {
    this.maxConcurrentEpisodeRequests = Math.max(
      1,
      options.maxConcurrentEpisodeRequests ??
        DEFAULT_MAX_CONCURRENT_EPISODE_REQUESTS,
    );
    this.noUrlRetryAttempts = Math.max(
      0,
      options.noUrlRetryAttempts ?? DEFAULT_NO_URL_RETRY_ATTEMPTS,
    );
    this.retryDelayMs = Math.max(
      0,
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    );
  }

  public async resolve(
    episodes: readonly UpstreamEpisodeReference[],
    options: {
      allowMixedSources?: boolean;
      signal?: AbortSignal;
      excludedFamilies?: ReadonlySet<string>;
      excludedCandidates?: ReadonlySet<string>;
    } = {},
  ): Promise<CandidateFamilySelection> {
    const sets = new Array<EpisodeCandidateSet | undefined>(episodes.length);
    let indexesToFetch = new Set(
      Array.from({ length: episodes.length }, (_, index) => index),
    );
    for (
      let familyAttempt = 0;
      familyAttempt <= DEFAULT_FAMILY_SELECTION_RETRY_ATTEMPTS;
      familyAttempt += 1
    ) {
      const indexes = [...indexesToFetch];
      let nextIndex = 0;
      const workerCount = Math.min(
        this.maxConcurrentEpisodeRequests,
        indexes.length,
      );
      let firstError: unknown;
      let hasError = false;
      const failedIndexes = new Set<number>();
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (true) {
            const position = nextIndex++;
            const index = indexes[position];
            if (index === undefined) return;
            const reference = episodes[index];
            if (reference === undefined) return;
            try {
              sets[index] = {
                reference,
                candidates: await this.getStreamsWithRetry(
                  reference,
                  options.signal,
                ),
              };
            } catch (error) {
              hasError = true;
              failedIndexes.add(index);
              if (firstError === undefined) firstError = error;
            }
          }
        }),
      );
      if (hasError) {
        if (
          !isRetryableFamilyError(firstError) ||
          familyAttempt >= DEFAULT_FAMILY_SELECTION_RETRY_ATTEMPTS
        )
          throw firstError instanceof Error
            ? firstError
            : new Error("Upstream stream resolution failed.");
        this.client.clearStreamCache();
        indexesToFetch = failedIndexes;
        await delayWithAbort(
          this.retryDelayMs * 2 ** Math.min(familyAttempt, 3),
          options.signal,
        );
        continue;
      }
      const readySets = sets.map((set) => {
        if (set === undefined)
          throw new Error(
            "Upstream stream resolution returned an incomplete set.",
          );
        return set;
      });
      try {
        return selectCandidateFamily(readySets, {
          allowMixedSources: options.allowMixedSources ?? false,
          preferMediaFlowCompatible: true,
          excludedFamilies: options.excludedFamilies,
          excludedCandidates: options.excludedCandidates,
        });
      } catch (error) {
        if (
          !isRetryableFamilyError(error) ||
          familyAttempt >= DEFAULT_FAMILY_SELECTION_RETRY_ATTEMPTS
        )
          throw error;
        this.client.clearStreamCache();
        indexesToFetch =
          error instanceof NoUsableStreamsError
            ? new Set(
                readySets.flatMap((set, index) =>
                  set.reference.episodeId === error.diagnostics.episodeId
                    ? [index]
                    : [],
                ),
              )
            : new Set(
                Array.from({ length: episodes.length }, (_, index) => index),
              );
        await delayWithAbort(
          this.retryDelayMs * 2 ** Math.min(familyAttempt, 3),
          options.signal,
        );
      }
    }
    throw new Error("Stream family resolution exhausted.");
  }

  private async getStreamsWithRetry(
    reference: UpstreamEpisodeReference,
    signal?: AbortSignal,
  ) {
    for (let attempt = 0; ; attempt += 1) {
      const candidates = await this.withRequestSlot(
        () => this.client.getStreams(reference, signal),
        signal,
      );
      if (
        candidates.some((candidate) => candidate.kind === "url") ||
        attempt >= this.noUrlRetryAttempts
      ) {
        return candidates;
      }
      await delayWithAbort(
        this.retryDelayMs * 2 ** Math.min(attempt, 3),
        signal,
      );
    }
  }

  private async withRequestSlot<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquireRequestSlot(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquireRequestSlot(
    signal?: AbortSignal,
  ): Promise<RequestSlotRelease> {
    if (signal?.aborted === true) return Promise.reject(abortError(signal));
    if (this.activeEpisodeRequests < this.maxConcurrentEpisodeRequests) {
      this.activeEpisodeRequests += 1;
      return Promise.resolve(() => this.releaseRequestSlot());
    }
    return new Promise<RequestSlotRelease>((resolve, reject) => {
      const pending: PendingRequestSlot = { resolve, reject, signal };
      const onAbort = () => {
        const index = this.pendingRequestSlots.indexOf(pending);
        if (index >= 0) this.pendingRequestSlots.splice(index, 1);
        reject(abortError(signal!));
      };
      pending.onAbort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingRequestSlots.push(pending);
    });
  }

  private releaseRequestSlot(): void {
    this.activeEpisodeRequests -= 1;
    while (this.pendingRequestSlots.length > 0) {
      const pending = this.pendingRequestSlots.shift()!;
      if (pending.signal?.aborted === true) {
        pending.onAbort?.();
        continue;
      }
      if (pending.onAbort !== undefined) {
        pending.signal?.removeEventListener("abort", pending.onAbort);
      }
      this.activeEpisodeRequests += 1;
      pending.resolve(() => this.releaseRequestSlot());
      return;
    }
  }
}

export function sanitizeCandidateSelection(
  selection: CandidateFamilySelection,
) {
  return {
    familyMethod: selection.familyMethod,
    episodes: selection.episodes.map((episode) => ({
      episodeId: episode.episodeId,
      rank: episode.upstreamRank,
      ...(episode.filename === undefined ? {} : { filename: episode.filename }),
      candidateKind: "url" as const,
    })),
    unsupported: {
      torrent: selection.unsupported.torrent,
      usenet: selection.unsupported.usenet,
      other:
        selection.unsupported.archive +
        selection.unsupported.youtube +
        selection.unsupported.external +
        selection.unsupported.unsupported,
    },
    warnings: selection.warnings,
  };
}
