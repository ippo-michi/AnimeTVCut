import {
  AniSkipProvider,
  TheIntroDbProvider,
  type SkipProviderResult,
  type SkipSegmentProvider,
} from "@animetvcut/skip-providers";

class DisabledSkipProvider implements SkipSegmentProvider {
  public readonly priority = Number.MAX_SAFE_INTEGER;
  public readonly enabled = false;

  public constructor(public readonly name: string) {}

  public supports(): boolean {
    return false;
  }

  public getSegments(): Promise<SkipProviderResult> {
    return Promise.resolve({
      provider: this.name,
      status: "unsupported_identity",
      segments: [],
      warnings: [],
    });
  }
}

function enabled(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === "") return true;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function optionalNumber(value: string | undefined): number | undefined {
  return value === undefined || value.trim() === "" ? undefined : Number(value);
}

export function skipProvidersFromEnv(
  environment: NodeJS.ProcessEnv,
): SkipSegmentProvider[] {
  const introEnabled = enabled(environment.INTRODB_ENABLED, "INTRODB_ENABLED");
  const aniSkipEnabled = enabled(
    environment.ANISKIP_ENABLED,
    "ANISKIP_ENABLED",
  );
  return [
    introEnabled
      ? new TheIntroDbProvider({
          ...(environment.INTRODB_BASE_URL === undefined
            ? {}
            : { baseUrl: environment.INTRODB_BASE_URL }),
          ...(environment.INTRODB_REQUEST_TIMEOUT_MS === undefined
            ? {}
            : {
                requestTimeoutMs: Number(
                  environment.INTRODB_REQUEST_TIMEOUT_MS,
                ),
              }),
          ...(optionalNumber(environment.INTRODB_MIN_CONFIDENCE) === undefined
            ? {}
            : {
                minimumConfidence: optionalNumber(
                  environment.INTRODB_MIN_CONFIDENCE,
                ),
              }),
        })
      : new DisabledSkipProvider("theintrodb"),
    aniSkipEnabled
      ? new AniSkipProvider({
          ...(environment.ANISKIP_BASE_URL === undefined
            ? {}
            : { baseUrl: environment.ANISKIP_BASE_URL }),
          ...(environment.ANISKIP_REQUEST_TIMEOUT_MS === undefined
            ? {}
            : {
                requestTimeoutMs: Number(
                  environment.ANISKIP_REQUEST_TIMEOUT_MS,
                ),
              }),
        })
      : new DisabledSkipProvider("aniskip"),
  ];
}
