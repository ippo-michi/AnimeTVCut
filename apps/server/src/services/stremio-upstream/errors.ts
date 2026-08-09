export class StremioUpstreamError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class StremioUpstreamConfigurationError extends StremioUpstreamError {}

export class StremioUpstreamNotConfiguredError extends StremioUpstreamError {
  public constructor() {
    super("Upstream Stremio addon is not configured.");
  }
}

export class StremioUpstreamUnavailableError extends StremioUpstreamError {
  public constructor(message = "Upstream Stremio addon is unavailable.") {
    super(message);
  }
}

export class StremioManifestInvalidError extends StremioUpstreamError {}

export class StremioManifestCompatibilityError extends StremioUpstreamError {}

export class StremioStreamResponseInvalidError extends StremioUpstreamError {}

export interface EpisodeSelectionDiagnostic {
  episodeId: string;
  upstreamResults: number;
  usableUrlCandidates: number;
  stableFamilyCandidates: number;
}

export class NoUsableStreamsError extends StremioUpstreamError {
  public constructor(public readonly diagnostics: EpisodeSelectionDiagnostic) {
    super(
      `Episode ${diagnostics.episodeId} had ${diagnostics.upstreamResults} upstream results but none were HTTP(S) URL streams usable by AnimeTVCut.`,
    );
  }
}

export class NoConsistentStreamFamilyError extends StremioUpstreamError {
  public constructor(
    public readonly diagnostics: readonly EpisodeSelectionDiagnostic[],
  ) {
    const episodeLabels = diagnostics.map((item) => item.episodeId).join(", ");
    super(
      `No consistent stream family was available across episodes ${episodeLabels}.`,
    );
  }
}
