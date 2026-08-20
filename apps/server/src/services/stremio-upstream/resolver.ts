import { selectCandidateFamily } from "./family-selection.js";
import type { StremioUpstreamClient } from "./client.js";
import type {
  CandidateFamilySelection,
  EpisodeCandidateSet,
  EpisodeSourceResolver,
  UpstreamEpisodeReference,
} from "./types.js";

const DEFAULT_MAX_CONCURRENT_EPISODE_REQUESTS = 4;
const DEFAULT_NO_URL_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

interface StremioEpisodeSourceResolverOptions {
  maxConcurrentEpisodeRequests?: number;
  noUrlRetryAttempts?: number;
  retryDelayMs?: number;
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
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal!));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class StremioEpisodeSourceResolver implements EpisodeSourceResolver {
  private readonly maxConcurrentEpisodeRequests: number;
  private readonly noUrlRetryAttempts: number;
  private readonly retryDelayMs: number;

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
    const sets = new Array<EpisodeCandidateSet>(episodes.length);
    let nextIndex = 0;
    const workerCount = Math.min(
      this.maxConcurrentEpisodeRequests,
      episodes.length,
    );
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = nextIndex++;
          const reference = episodes[index];
          if (reference === undefined) return;
          sets[index] = {
            reference,
            candidates: await this.getStreamsWithRetry(
              reference,
              options.signal,
            ),
          };
        }
      }),
    );
    return selectCandidateFamily(sets, {
      allowMixedSources: options.allowMixedSources ?? false,
      preferMediaFlowCompatible: true,
      excludedFamilies: options.excludedFamilies,
      excludedCandidates: options.excludedCandidates,
    });
  }

  private async getStreamsWithRetry(
    reference: UpstreamEpisodeReference,
    signal?: AbortSignal,
  ) {
    for (let attempt = 0; ; attempt += 1) {
      const candidates = await this.client.getStreams(reference, signal);
      if (
        candidates.some((candidate) => candidate.kind === "url") ||
        attempt >= this.noUrlRetryAttempts
      ) {
        return candidates;
      }
      await delayWithAbort(this.retryDelayMs, signal);
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
