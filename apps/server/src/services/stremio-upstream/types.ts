import type { HttpMediaSource } from "../hls-source-loader.js";

export interface UpstreamEpisodeReference {
  episodeId: string;
  type: string;
  videoId: string;
}

export interface StremioManifestResource {
  name: string;
  types?: readonly string[];
  idPrefixes?: readonly string[];
}

export interface StremioManifest {
  id: string;
  name: string;
  version: string;
  types: readonly string[];
  idPrefixes?: readonly string[];
  resources: readonly StremioManifestResource[];
}

export type StremioCandidateKind =
  | "url"
  | "torrent"
  | "usenet"
  | "archive"
  | "youtube"
  | "external"
  | "unsupported";

interface CandidateBase {
  rank: number;
  kind: StremioCandidateKind;
  name?: string;
  description?: string;
}

export interface UrlStreamCandidate extends CandidateBase {
  kind: "url";
  url: string;
  filename?: string;
  videoSize?: number;
  bingeGroup?: string;
  notWebReady?: boolean;
  requestHeaders: Readonly<Record<string, string>>;
}

export interface UnsupportedStreamCandidate extends CandidateBase {
  kind: Exclude<StremioCandidateKind, "url">;
  reason: string;
}

export type StremioStreamCandidate =
  UrlStreamCandidate | UnsupportedStreamCandidate;

export interface UnsupportedCandidateCounts {
  torrent: number;
  usenet: number;
  archive: number;
  youtube: number;
  external: number;
  unsupported: number;
}

export interface EpisodeCandidateSet {
  reference: UpstreamEpisodeReference;
  candidates: readonly StremioStreamCandidate[];
}

export type CandidateFamilyMethod = "binge_group" | "filename_family" | "mixed";

export interface SelectedEpisodeSource {
  episodeId: string;
  upstreamType: string;
  upstreamVideoId: string;
  upstreamRank: number;
  familyMethod: CandidateFamilyMethod;
  familyKey: string;
  mediaSource: HttpMediaSource;
  filename?: string;
}

export interface CandidateFamilySelection {
  familyMethod: CandidateFamilyMethod;
  familyKey: string;
  episodes: readonly SelectedEpisodeSource[];
  unsupported: UnsupportedCandidateCounts;
  warnings: readonly string[];
}

export interface SanitizedSelectionEpisode {
  episodeId: string;
  rank: number;
  filename?: string;
  candidateKind: "url";
}

export interface SanitizedCandidateSelection {
  familyMethod: CandidateFamilyMethod;
  episodes: readonly SanitizedSelectionEpisode[];
  unsupported: {
    torrent: number;
    usenet: number;
    other: number;
  };
  warnings: readonly string[];
}

export interface EpisodeSourceResolver {
  resolve(
    episodes: readonly UpstreamEpisodeReference[],
    options?: { allowMixedSources?: boolean; signal?: AbortSignal },
  ): Promise<CandidateFamilySelection>;
}
