import {
  InvalidVirtualStremioIdError,
  MetadataStremioError,
} from "@animetvcut/stremio";
import { PreparedSourceError } from "./cut-service.js";
import { SessionCapacityError } from "./cut-session-store.js";
import {
  NoConsistentStreamFamilyError,
  NoUsableStreamsError,
  StremioUpstreamError,
} from "./stremio-upstream/errors.js";
import {
  MediaFlowSourceError,
  MediaFlowUnavailableError,
} from "./mediaflow/errors.js";

export const availabilityMessages = {
  still_airing:
    "This cut is waiting for the season or episode group to finish airing.",
  unknown_release_dates:
    "Release dates are missing, so this cut cannot be finalized safely.",
  episode_gap:
    "Episode metadata has a gap. A complete cut needs consecutive episodes.",
  episode_limit:
    "This cut exceeds the server's episode limit. Try a TV Cut instead.",
  duration_limit:
    "This cut exceeds the server's duration limit. Try a shorter cut.",
  no_normal_seasons: "No normal seasons are available in the source metadata.",
  no_matching_release:
    "No matching release is available across all included episodes. Try different playback preferences or a shorter cut.",
  no_sources: "An included episode has no usable source for these preferences.",
  upstream_unavailable: "The upstream addon is unavailable. Try again shortly.",
  metadata_unavailable: "Series metadata is unavailable. Try again shortly.",
  media_unavailable:
    "The selected source could not be prepared. Try again or choose another playback preference.",
  capacity:
    "The server is busy preparing or serving other cuts. Try again shortly.",
  invalid_cut:
    "This cut is no longer in the current plan. Search for the series again.",
  disabled: "This cut mode is disabled by the server.",
  unavailable:
    "This cut could not be prepared. Check server connections and try again.",
} as const;
export type AvailabilityReason = keyof typeof availabilityMessages;
export class CutUnavailableError extends InvalidVirtualStremioIdError {
  public constructor(public readonly reason: AvailabilityReason) {
    super(availabilityMessages[reason]);
  }
}
export function explainCutFailure(error: unknown): {
  reason: AvailabilityReason;
  message: string;
} {
  if (error instanceof PreparedSourceError)
    return explainCutFailure(error.cause);
  const reason: AvailabilityReason =
    error instanceof CutUnavailableError
      ? error.reason
      : error instanceof NoConsistentStreamFamilyError
        ? "no_matching_release"
        : error instanceof NoUsableStreamsError
          ? "no_sources"
          : error instanceof SessionCapacityError
            ? "capacity"
            : error instanceof MetadataStremioError
              ? "metadata_unavailable"
              : error instanceof MediaFlowUnavailableError ||
                  error instanceof MediaFlowSourceError
                ? "media_unavailable"
                : error instanceof StremioUpstreamError
                  ? "upstream_unavailable"
                  : error instanceof InvalidVirtualStremioIdError
                    ? "invalid_cut"
                    : "unavailable";
  return { reason, message: availabilityMessages[reason] };
}
