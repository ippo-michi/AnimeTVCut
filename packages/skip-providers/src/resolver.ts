import { reconcileSkipSegments } from "./reconciliation.js";
import type {
  EpisodeSkipResolution,
  SkipLookupIdentity,
  SkipProviderHealth,
  SkipProviderResult,
  SkipSegmentProvider,
} from "./models.js";

export interface EpisodeSkipRequest {
  episodeId: string;
  identity: SkipLookupIdentity;
  durationSeconds: number;
}

export class SkipSegmentResolver {
  public constructor(
    public readonly providers: readonly SkipSegmentProvider[],
    private readonly concurrency = 4,
  ) {
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 32
    ) {
      throw new Error("Skip resolver concurrency must be between 1 and 32.");
    }
  }

  public async resolveEpisode(
    request: EpisodeSkipRequest,
    signal?: AbortSignal,
  ): Promise<EpisodeSkipResolution> {
    const results: SkipProviderResult[] = await Promise.all(
      this.providers.map(async (provider) => {
        if (
          provider.enabled === false ||
          !provider.supports(request.identity)
        ) {
          return {
            provider: provider.name,
            status: "unsupported_identity" as const,
            segments: [],
            warnings: [],
          };
        }
        try {
          return await provider.getSegments({
            identity: request.identity,
            durationSeconds: request.durationSeconds,
            ...(signal === undefined ? {} : { signal }),
          });
        } catch {
          return {
            provider: provider.name,
            status: "provider_failed" as const,
            segments: [],
            warnings: [`${provider.name} lookup failed.`],
          };
        }
      }),
    );
    const reconciled = reconcileSkipSegments(results, this.providers);
    return {
      episodeId: request.episodeId,
      identity: request.identity,
      durationSeconds: request.durationSeconds,
      providers: results.map(({ provider, status, warnings }) => ({
        provider,
        status,
        warnings,
      })),
      segments: reconciled.segments,
      warnings: [
        ...results.flatMap((result) => [...result.warnings]),
        ...reconciled.warnings,
      ],
    };
  }

  public async resolveEpisodes(
    requests: readonly EpisodeSkipRequest[],
    signal?: AbortSignal,
  ): Promise<EpisodeSkipResolution[]> {
    const results = new Array<EpisodeSkipResolution>(requests.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(this.concurrency, requests.length) },
      async () => {
        while (nextIndex < requests.length) {
          const index = nextIndex;
          nextIndex += 1;
          results[index] = await this.resolveEpisode(requests[index]!, signal);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  public async health(): Promise<SkipProviderHealth[]> {
    return Promise.all(
      this.providers.map(async (provider) => ({
        name: provider.name,
        enabled: provider.enabled !== false,
        reachable:
          provider.enabled === false
            ? false
            : provider.checkHealth === undefined
              ? true
              : await provider.checkHealth(),
      })),
    );
  }
}
