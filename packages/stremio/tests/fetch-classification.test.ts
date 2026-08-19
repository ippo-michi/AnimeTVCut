import { describe, expect, it } from "vitest";

import { classifyFetchFailure } from "../src/client.js";

describe("classifyFetchFailure", () => {
  it("classifies caller abort as cancelled", () => {
    const controller = new AbortController();
    controller.abort();
    const timeoutSignal = AbortSignal.timeout(60_000);

    expect(classifyFetchFailure(controller.signal, timeoutSignal)).toBe(
      "cancelled",
    );
  });

  it("classifies internal timeout as timeout", () => {
    const callerSignal = new AbortController().signal;
    const timeoutSignal = AbortSignal.timeout(1);

    // Wait for timeout to fire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(classifyFetchFailure(callerSignal, timeoutSignal)).toBe(
          "timeout",
        );
        resolve();
      }, 50);
    });
  });

  it("classifies immediate fetch rejection as network_error", () => {
    const callerSignal = new AbortController().signal;
    const timeoutSignal = AbortSignal.timeout(60_000);

    expect(classifyFetchFailure(callerSignal, timeoutSignal)).toBe(
      "network_error",
    );
  });

  it("prefers cancelled over timeout when both signals are aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const timeoutSignal = AbortSignal.timeout(1);

    // Wait for timeout to fire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(classifyFetchFailure(controller.signal, timeoutSignal)).toBe(
          "cancelled",
        );
        resolve();
      }, 50);
    });
  });

  it("classifies undefined caller signal as timeout when timeout fires", () => {
    const timeoutSignal = AbortSignal.timeout(1);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(classifyFetchFailure(undefined, timeoutSignal)).toBe("timeout");
        resolve();
      }, 50);
    });
  });
});
