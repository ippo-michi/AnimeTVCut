export type SkipSegmentType = "opening" | "ending" | "recap" | "preview";

export type UnsafeSkipReason =
  | "open_ended"
  | "mixed_content"
  | "invalid_range"
  | "low_confidence"
  | "outside_duration"
  | "duration_mismatch";

export interface SkipSegment {
  type: SkipSegmentType;
  start: number;
  end: number | null;
  provider: string;
  confidence?: number;
  submissionCount?: number;
  sourceType?: string;
  automaticRemoval: boolean;
  unsafeReason?: UnsafeSkipReason;
  reportedStart?: number;
  reportedEnd?: number;
}

export interface ImdbSkipIdentity {
  id: string;
  season: number;
  episode: number;
}

export interface MalSkipIdentity {
  animeId: number;
  episode: number;
}

export interface SkipLookupIdentity {
  imdb?: ImdbSkipIdentity;
  mal?: MalSkipIdentity;
}

export interface ExplicitSkipIdentity {
  imdbId?: string;
  imdbSeason?: number;
  imdbEpisode?: number;
  malAnimeId?: number;
  malEpisode?: number;
}

export interface SkipSegmentRequest {
  identity: SkipLookupIdentity;
  durationSeconds: number;
  signal?: AbortSignal;
}

export type SkipProviderStatus =
  "found" | "not_found" | "unsupported_identity" | "provider_failed";

export interface SkipProviderResult {
  provider: string;
  status: SkipProviderStatus;
  segments: readonly SkipSegment[];
  warnings: readonly string[];
}

export interface SkipProviderHealth {
  name: string;
  enabled: boolean;
  reachable: boolean;
}

export interface SkipSegmentProvider {
  readonly name: string;
  readonly priority: number;
  readonly enabled?: boolean;
  supports(identity: SkipLookupIdentity): boolean;
  getSegments(request: SkipSegmentRequest): Promise<SkipProviderResult>;
  checkHealth?(): Promise<boolean>;
}

export interface AlternativeSkipReport {
  provider: string;
  start: number;
  end: number;
}

export interface ReconciledSkipSegment extends SkipSegment {
  alternatives?: readonly AlternativeSkipReport[];
}

export interface EpisodeSkipResolution {
  episodeId: string;
  identity: SkipLookupIdentity;
  durationSeconds: number;
  providers: readonly Omit<SkipProviderResult, "segments">[];
  segments: readonly ReconciledSkipSegment[];
  warnings: readonly string[];
}

export type OpeningCutPolicy = "first_only" | "remove_all" | "keep_all";
export type EndingCutPolicy = "last_only" | "remove_all" | "keep_all";

export interface AutomaticCutPolicy {
  openings: OpeningCutPolicy;
  endings: EndingCutPolicy;
  removeRecaps: boolean;
  removePreviews: boolean;
}

export type SkipPolicyDecision =
  | "remove"
  | "keep_first_opening"
  | "keep_last_ending"
  | "keep_by_policy"
  | "unsafe_ignored";

export interface PlannedSkipSegment extends ReconciledSkipSegment {
  decision: SkipPolicyDecision;
}

export interface EpisodeAutomaticCutPlan {
  episodeId: string;
  segments: readonly PlannedSkipSegment[];
}

export interface AutomaticRemoval {
  episodeId: string;
  start: number;
  end: number;
  type: SkipSegmentType;
}

export interface AutomaticCutPlan {
  policy: AutomaticCutPolicy;
  episodes: readonly EpisodeAutomaticCutPlan[];
  automaticRemovals: readonly AutomaticRemoval[];
  warnings: readonly string[];
}
