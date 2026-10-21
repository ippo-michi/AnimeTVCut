import { describe, expect, it, vi } from "vitest";

import { fetchBoundedJson, SkipProviderHttpError } from "../src/http.js";

describe("bounded provider responses", () => {
  it("cancels an oversized chunked body and preserves its typed error", async () => {
    const cancel = vi.fn();
    const result = fetchBoundedJson(new URL("https://provider.test"), {
      timeoutMs: 1000,
      maximumBytes: 16,
      fetchImplementation: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(17));
            },
            cancel,
          }),
        ),
    });
    await expect(result).rejects.toBeInstanceOf(SkipProviderHttpError);
    await expect(result).rejects.toMatchObject({
      category: "invalid_response",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
