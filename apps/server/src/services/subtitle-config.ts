export interface SubtitleConfigInput {
  enabled?: boolean;
  requestTimeoutMs?: number;
  maxSourceBytes?: number;
  maxGeneratedBytes?: number;
  maxRedirects?: number;
  allowPrivateNetworks?: boolean;
  allowedOrigins?: readonly (string | URL)[];
  composeFetchConcurrency?: number;
}
export interface SubtitleConfig {
  enabled: boolean;
  requestTimeoutMs: number;
  maxSourceBytes: number;
  maxGeneratedBytes: number;
  maxRedirects: number;
  allowPrivateNetworks: boolean;
  allowedOrigins: ReadonlySet<string>;
  composeFetchConcurrency: number;
}
function integer(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`Invalid subtitle ${name}.`);
  return value;
}
export function createSubtitleConfig(
  input: SubtitleConfigInput = {},
): SubtitleConfig {
  const origins = new Set<string>();
  for (const value of input.allowedOrigins ?? []) {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    )
      throw new Error("Invalid subtitle allowed origin.");
    origins.add(url.origin);
  }
  return {
    enabled: input.enabled ?? true,
    requestTimeoutMs: integer(
      input.requestTimeoutMs ?? 10_000,
      "request timeout",
      1,
    ),
    maxSourceBytes: integer(
      input.maxSourceBytes ?? 5_242_880,
      "source size",
      1,
    ),
    maxGeneratedBytes: integer(
      input.maxGeneratedBytes ?? 10_485_760,
      "generated size",
      1,
    ),
    maxRedirects: integer(input.maxRedirects ?? 3, "redirect count", 0),
    allowPrivateNetworks: input.allowPrivateNetworks ?? false,
    allowedOrigins: origins,
    composeFetchConcurrency: integer(
      input.composeFetchConcurrency ?? 4,
      "compose fetch concurrency",
      1,
    ),
  };
}
export function subtitleConfigFromEnv(
  env: NodeJS.ProcessEnv,
): SubtitleConfigInput {
  const numberValue = (name: string, fallback: number) =>
    env[name] === undefined ? fallback : Number(env[name]);
  return {
    enabled: env.SUBTITLES_ENABLED?.toLowerCase() !== "false",
    requestTimeoutMs: numberValue("SUBTITLE_REQUEST_TIMEOUT_MS", 10_000),
    maxSourceBytes: numberValue("SUBTITLE_MAX_SOURCE_BYTES", 5_242_880),
    allowPrivateNetworks:
      env.SUBTITLE_ALLOW_PRIVATE_NETWORKS?.toLowerCase() === "true",
    allowedOrigins: (env.SUBTITLE_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    composeFetchConcurrency: numberValue(
      "SUBTITLE_COMPOSE_FETCH_CONCURRENCY",
      4,
    ),
  };
}
