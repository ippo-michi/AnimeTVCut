import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import type { SubtitleConfig } from "./subtitle-config.js";

export class SubtitleFetchError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "SubtitleFetchError";
  }
}
export interface FetchedSubtitle {
  bytes: Uint8Array;
  contentType?: string;
}

function blockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number),
    [a, b] = parts;
  if (parts.length !== 4 || a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 2 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
function blockedAddress(address: string): boolean {
  if (isIP(address) === 4) return blockedIpv4(address);
  const value = address.toLowerCase().split("%", 1)[0]!;
  if (
    value === "::" ||
    value === "::1" ||
    value.startsWith("ff") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb") ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("2001:db8")
  )
    return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  return mapped?.[1] === undefined ? false : blockedIpv4(mapped[1]);
}

export class SafeSubtitleFetcher {
  public constructor(
    private readonly config: SubtitleConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly dnsLookup = lookup,
  ) {}

  public async fetch(
    urlText: string,
    callerSignal?: AbortSignal,
  ): Promise<FetchedSubtitle> {
    let current = await this.validateUrl(urlText);
    for (let redirects = 0; ; redirects += 1) {
      const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
      const signal =
        callerSignal === undefined
          ? timeout
          : AbortSignal.any([callerSignal, timeout]);
      let response: Response;
      try {
        response = await this.fetchImplementation(current, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: {
            accept:
              "text/vtt,application/x-subrip,text/plain,application/octet-stream",
          },
        });
      } catch {
        throw new SubtitleFetchError(
          callerSignal?.aborted === true
            ? "cancelled"
            : "timeout_or_unavailable",
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (location === null) throw new SubtitleFetchError("invalid_redirect");
        if (redirects >= this.config.maxRedirects)
          throw new SubtitleFetchError("too_many_redirects");
        current = await this.validateUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        throw new SubtitleFetchError(`http_${response.status}`);
      }
      const declared = response.headers.get("content-length");
      if (
        declared !== null &&
        /^\d+$/.test(declared) &&
        Number(declared) > this.config.maxSourceBytes
      ) {
        await response.body.cancel();
        throw new SubtitleFetchError("oversized_subtitle");
      }
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.byteLength;
        if (length > this.config.maxSourceBytes)
          throw new SubtitleFetchError("oversized_subtitle");
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const contentType = response.headers.get("content-type") ?? undefined;
      return { bytes, ...(contentType === undefined ? {} : { contentType }) };
    }
  }

  private async validateUrl(value: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new SubtitleFetchError("invalid_url");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new SubtitleFetchError("unsupported_scheme");
    if (url.username !== "" || url.password !== "")
      throw new SubtitleFetchError("embedded_credentials");
    if (
      this.config.allowedOrigins.has(url.origin) ||
      this.config.allowPrivateNetworks
    )
      return url;
    let addresses: readonly { address: string }[];
    const hostname =
      url.hostname.startsWith("[") && url.hostname.endsWith("]")
        ? url.hostname.slice(1, -1)
        : url.hostname;
    if (isIP(hostname) !== 0 && blockedAddress(hostname))
      throw new SubtitleFetchError("blocked_destination");
    try {
      addresses = await this.dnsLookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new SubtitleFetchError("dns_failure");
    }
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => blockedAddress(address))
    )
      throw new SubtitleFetchError("blocked_destination");
    return url;
  }
}
