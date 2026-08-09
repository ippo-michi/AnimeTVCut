import { describe, expect, it, vi } from "vitest";
import {
  createSubtitleConfig,
  subtitleConfigFromEnv,
} from "../src/services/subtitle-config.js";
import {
  SafeSubtitleFetcher,
  SubtitleFetchError,
} from "../src/services/subtitle-fetcher.js";

describe("safe subtitle fetcher", () => {
  it.each([
    "file:///etc/passwd",
    "data:text/plain,x",
    "ftp://example.test/x.srt",
    "http://user:pass@example.test/x.srt",
  ])("rejects unsafe URL %s", async (url) => {
    await expect(
      new SafeSubtitleFetcher(createSubtitleConfig()).fetch(url),
    ).rejects.toBeInstanceOf(SubtitleFetchError);
  });
  it.each([
    "http://127.0.0.1/x.srt",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1/x",
    "http://224.0.0.1/x",
    "http://[::1]/x",
  ])("blocks private or special destination %s", async (url) => {
    await expect(
      new SafeSubtitleFetcher(createSubtitleConfig()).fetch(url),
    ).rejects.toThrow("blocked_destination");
  });
  it("allows an explicitly trusted private fixture origin", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOK"),
      );
    const result = await new SafeSubtitleFetcher(
      createSubtitleConfig({ allowedOrigins: ["http://127.0.0.1:9000"] }),
      fetcher,
    ).fetch("http://127.0.0.1:9000/test.vtt");
    expect(new TextDecoder().decode(result.bytes)).toContain("WEBVTT");
  });
  it("validates redirect targets and blocks metadata redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/secret" },
      }),
    );
    await expect(
      new SafeSubtitleFetcher(
        createSubtitleConfig({ allowedOrigins: ["https://cdn.test"] }),
        fetcher,
      ).fetch("https://cdn.test/a.srt"),
    ).rejects.toThrow("blocked_destination");
  });
  it("bounds redirect loops", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "/loop" } }),
      );
    await expect(
      new SafeSubtitleFetcher(
        createSubtitleConfig({
          allowedOrigins: ["https://cdn.test"],
          maxRedirects: 2,
        }),
        fetcher,
      ).fetch("https://cdn.test/loop"),
    ).rejects.toThrow("too_many_redirects");
  });
  it("bounds declared and streamed source bytes", async () => {
    const declared = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("large", { headers: { "content-length": "100" } }),
      );
    await expect(
      new SafeSubtitleFetcher(
        createSubtitleConfig({
          allowedOrigins: ["https://cdn.test"],
          maxSourceBytes: 4,
        }),
        declared,
      ).fetch("https://cdn.test/a.srt"),
    ).rejects.toThrow("oversized_subtitle");
    const streamed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("12345"));
    await expect(
      new SafeSubtitleFetcher(
        createSubtitleConfig({
          allowedOrigins: ["https://cdn.test"],
          maxSourceBytes: 4,
        }),
        streamed,
      ).fetch("https://cdn.test/a.srt"),
    ).rejects.toThrow("oversized_subtitle");
  });
  it("classifies timeouts without exposing URLs", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("https://signed.test/?secret=x"));
    const error = await new SafeSubtitleFetcher(
      createSubtitleConfig({ allowedOrigins: ["https://signed.test"] }),
      fetcher,
    )
      .fetch("https://signed.test/a.srt")
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "timeout_or_unavailable",
      message: "timeout_or_unavailable",
    });
    expect(String(error)).not.toContain("secret");
  });
  it("propagates caller cancellation to the HTTP request", async () => {
    let observed: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      observed = init?.signal ?? undefined;
      if (observed?.aborted === true) throw new Error("aborted");
      return await new Promise<Response>((_resolve, reject) =>
        observed?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
    });
    const controller = new AbortController();
    const request = new SafeSubtitleFetcher(
      createSubtitleConfig({ allowedOrigins: ["https://cdn.test"] }),
      fetcher,
    ).fetch("https://cdn.test/a.srt", controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "cancelled" });
    expect(observed?.aborted).toBe(true);
  });
  it("parses environment defaults without enabling private networks", () => {
    expect(subtitleConfigFromEnv({})).toMatchObject({
      enabled: true,
      requestTimeoutMs: 10_000,
      maxSourceBytes: 5_242_880,
      allowPrivateNetworks: false,
    });
  });
});
