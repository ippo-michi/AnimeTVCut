import { MediaFlowConfigurationError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface MediaFlowConfigInput {
  baseUrl: string | URL;
  apiPassword?: string;
  requestTimeoutMs?: number;
  outputContainer?: "fmp4" | "mpegts";
}

export interface MediaFlowConfig {
  baseUrl: URL;
  apiPassword?: string;
  requestTimeoutMs: number;
  outputContainer: "fmp4" | "mpegts";
}

export function createMediaFlowConfig(
  input: MediaFlowConfigInput,
): MediaFlowConfig {
  let baseUrl: URL;
  try {
    baseUrl = new URL(input.baseUrl.toString());
  } catch {
    throw new MediaFlowConfigurationError("MEDIAFLOW_URL is invalid.");
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new MediaFlowConfigurationError(
      "MEDIAFLOW_URL must use HTTP or HTTPS.",
    );
  }
  if (baseUrl.username !== "" || baseUrl.password !== "") {
    throw new MediaFlowConfigurationError(
      "MEDIAFLOW_URL must not contain credentials.",
    );
  }
  if (baseUrl.pathname !== "" && baseUrl.pathname !== "/") {
    throw new MediaFlowConfigurationError(
      "MEDIAFLOW_URL must not contain a path.",
    );
  }
  baseUrl.pathname = "/";
  baseUrl.search = "";
  baseUrl.hash = "";

  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs <= 0 ||
    requestTimeoutMs > 5 * 60 * 1000
  ) {
    throw new MediaFlowConfigurationError(
      "MEDIAFLOW_REQUEST_TIMEOUT_MS must be between 1 and 300000.",
    );
  }
  if (
    input.apiPassword?.includes("\r") === true ||
    input.apiPassword?.includes("\n") === true
  ) {
    throw new MediaFlowConfigurationError("MEDIAFLOW_API_PASSWORD is invalid.");
  }
  if (
    input.outputContainer !== undefined &&
    input.outputContainer !== "fmp4" &&
    input.outputContainer !== "mpegts"
  ) {
    throw new MediaFlowConfigurationError(
      "MEDIAFLOW_OUTPUT_CONTAINER must be fmp4 or mpegts.",
    );
  }

  return {
    baseUrl,
    ...(input.apiPassword === undefined || input.apiPassword === ""
      ? {}
      : { apiPassword: input.apiPassword }),
    requestTimeoutMs,
    outputContainer: input.outputContainer ?? "fmp4",
  };
}

export function mediaFlowConfigFromEnv(
  environment: NodeJS.ProcessEnv,
): MediaFlowConfigInput | undefined {
  const baseUrl = environment.MEDIAFLOW_URL;
  if (baseUrl === undefined || baseUrl.trim() === "") {
    return undefined;
  }
  const timeout = environment.MEDIAFLOW_REQUEST_TIMEOUT_MS;
  const outputContainer = environment.MEDIAFLOW_OUTPUT_CONTAINER;
  return {
    baseUrl,
    ...(environment.MEDIAFLOW_API_PASSWORD === undefined
      ? {}
      : { apiPassword: environment.MEDIAFLOW_API_PASSWORD }),
    ...(timeout === undefined ? {} : { requestTimeoutMs: Number(timeout) }),
    ...(outputContainer === undefined
      ? {}
      : { outputContainer: outputContainer as "fmp4" | "mpegts" }),
  };
}
