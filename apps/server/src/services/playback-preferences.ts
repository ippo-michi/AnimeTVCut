import { z } from "zod";
import type { AutomaticCutPolicy } from "@animetvcut/skip-providers";

// Profiles contain only playback choices. Deployment credentials stay on the server.
export const playbackPreferencesSchema = z
  .object({
    episodesPerGroup: z.number().int().min(1).max(12).optional(),
    openings: z.enum(["remove_all", "first_only", "keep_all"]).optional(),
    endings: z.enum(["remove_all", "last_only", "keep_all"]).optional(),
    removeRecaps: z.boolean().optional(),
    removePreviews: z.boolean().optional(),
    language: z.enum(["default", "japanese", "english", "dual"]).optional(),
    maxResolution: z.enum(["720", "1080", "2160", "unlimited"]).optional(),
    priority: z.enum(["startup", "quality"]).optional(),
  })
  .strict();
export type PlaybackPreferences = z.infer<typeof playbackPreferencesSchema>;
export function encodePreferences(input: PlaybackPreferences): string {
  const preferences = playbackPreferencesSchema.parse(input);
  return Buffer.from(JSON.stringify(preferences)).toString("base64url");
}
export function decodePreferences(value: string): PlaybackPreferences {
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid playback profile.");
  return playbackPreferencesSchema.parse(
    JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
  );
}
export function cutPolicyFor(
  preferences: PlaybackPreferences,
): Partial<AutomaticCutPolicy> {
  return {
    ...(preferences.openings === undefined
      ? {}
      : { openings: preferences.openings }),
    ...(preferences.endings === undefined
      ? {}
      : { endings: preferences.endings }),
    ...(preferences.removeRecaps === undefined
      ? {}
      : { removeRecaps: preferences.removeRecaps }),
    ...(preferences.removePreviews === undefined
      ? {}
      : { removePreviews: preferences.removePreviews }),
  };
}
