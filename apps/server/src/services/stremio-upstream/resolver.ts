import { selectCandidateFamily } from "./family-selection.js";
import type { StremioUpstreamClient } from "./client.js";
import type {
  CandidateFamilySelection,
  EpisodeCandidateSet,
  EpisodeSourceResolver,
  UpstreamEpisodeReference,
} from "./types.js";

export class StremioEpisodeSourceResolver implements EpisodeSourceResolver {
  public constructor(public readonly client: StremioUpstreamClient) {}

  public async resolve(
    episodes: readonly UpstreamEpisodeReference[],
    options: { allowMixedSources?: boolean; signal?: AbortSignal } = {},
  ): Promise<CandidateFamilySelection> {
    const sets: EpisodeCandidateSet[] = await Promise.all(
      episodes.map(async (reference) => ({
        reference,
        candidates: await this.client.getStreams(reference, options.signal),
      })),
    );
    return selectCandidateFamily(sets, {
      allowMixedSources: options.allowMixedSources ?? false,
    });
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
