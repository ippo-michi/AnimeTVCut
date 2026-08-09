export class SkipProviderHttpError extends Error {
  public constructor(
    public readonly category:
      "unavailable" | "http_failure" | "invalid_response",
    message: string,
  ) {
    super(message);
    this.name = "SkipProviderHttpError";
  }
}

export interface BoundedJsonResponse {
  status: number;
  body?: unknown;
}

export interface ProviderHttpOptions {
  timeoutMs: number;
  maximumBytes: number;
  fetchImplementation?: typeof fetch;
}

function contentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function fetchBoundedJson(
  url: URL,
  options: ProviderHttpOptions,
  callerSignal?: AbortSignal,
): Promise<BoundedJsonResponse> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal =
    callerSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([callerSignal, timeoutSignal]);
  let response: Response;
  try {
    response = await (options.fetchImplementation ?? fetch)(url, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { accept: "application/json" },
    });
  } catch {
    throw new SkipProviderHttpError(
      "unavailable",
      "Skip timestamp provider request timed out or failed.",
    );
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new SkipProviderHttpError(
      "http_failure",
      "Skip timestamp provider returned an unexpected redirect.",
    );
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return { status: 404 };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new SkipProviderHttpError(
      "http_failure",
      `Skip timestamp provider returned HTTP ${response.status}.`,
    );
  }
  const declaredLength = contentLength(response);
  if (declaredLength !== undefined && declaredLength > options.maximumBytes) {
    await response.body?.cancel();
    throw new SkipProviderHttpError(
      "invalid_response",
      "Skip timestamp provider response is too large.",
    );
  }
  if (response.body === null) {
    throw new SkipProviderHttpError(
      "invalid_response",
      "Skip timestamp provider response body is empty.",
    );
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > options.maximumBytes) {
      await response.body.cancel();
      throw new SkipProviderHttpError(
        "invalid_response",
        "Skip timestamp provider response is too large.",
      );
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      status: response.status,
      body: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    };
  } catch {
    throw new SkipProviderHttpError(
      "invalid_response",
      "Skip timestamp provider returned malformed JSON.",
    );
  }
}

export async function checkProviderReachable(
  baseUrl: URL,
  timeoutMs: number,
  fetchImplementation: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImplementation(baseUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}
