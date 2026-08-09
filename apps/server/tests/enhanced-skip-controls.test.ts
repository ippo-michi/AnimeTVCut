import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface EnhancedCore {
  SETTINGS: readonly {
    key: string;
    type: string;
    defaultValue: boolean;
  }[];
  activeSegment(
    segments: readonly Record<string, unknown>[],
    currentTime: number,
  ): Record<string, unknown> | undefined;
  deriveSegmentsUrl(value: string): string | undefined;
  exactSkipTarget(
    segment: Record<string, unknown> | undefined,
    currentTime: number,
  ): number | undefined;
  requestIsCurrent(
    expectedGeneration: number,
    currentGeneration: number,
    expectedUrl: string,
    currentUrl: string,
  ): boolean;
  shouldAutoSkip(type: string, settings: Record<string, boolean>): boolean;
  shouldRearm(
    segment: Record<string, unknown>,
    currentTime: number,
    previousTime: number,
  ): boolean;
  validatePayload(
    value: unknown,
  ):
    | { duration: number; segments: readonly Record<string, unknown>[] }
    | undefined;
}

async function loadCore(): Promise<EnhancedCore> {
  // The distributed plugin intentionally has no module exports; in Node it only
  // installs its testable, side-effect-free core because no DOM is present.
  // @ts-expect-error JavaScript plugin intentionally has no declaration file.
  await import("../../../integrations/stremio-enhanced/AnimeTVCutSkip.plugin.js");
  return (globalThis as { AnimeTVCutSkipCore: EnhancedCore })
    .AnimeTVCutSkipCore;
}

describe("Stremio Enhanced AnimeTVCut plugin core", () => {
  it("derives only a same-cut metadata URL from valid AnimeTVCut media", async () => {
    const core = await loadCore();
    expect(
      core.deriveSegmentsUrl(
        "https://atc.example/media/cut/cut_123/master.m3u8?ignored=yes",
      ),
    ).toBe("https://atc.example/media/cut/cut_123/segments.json");
    expect(
      core.deriveSegmentsUrl(
        "https://atc.example/media/cut/cut_123/segment/r0001.m4s",
      ),
    ).toBe("https://atc.example/media/cut/cut_123/segments.json");
    expect(
      core.deriveSegmentsUrl("https://atc.example/health"),
    ).toBeUndefined();
    expect(
      core.deriveSegmentsUrl(
        "https://user:secret@atc.example/media/cut/c/master.m3u8",
      ),
    ).toBeUndefined();
  });

  it("validates the shared payload and uses exact half-open boundaries", async () => {
    const core = await loadCore();
    const fixture = JSON.parse(
      await readFile(
        new URL(
          "../../../integrations/skip-controls-fixtures/basic.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const payload = core.validatePayload(fixture);
    expect(payload?.segments).toHaveLength(3);
    expect(core.activeSegment(payload!.segments, 0)?.id).toBe("s01");
    expect(core.activeSegment(payload!.segments, 5.999)?.id).toBe("s01");
    expect(core.activeSegment(payload!.segments, 6)).toBeUndefined();
    expect(core.activeSegment(payload!.segments, 60)?.id).toBe("s02");
    expect(core.exactSkipTarget(payload!.segments[1], 62)).toBe(66);
    expect(core.exactSkipTarget(payload!.segments[1], 66)).toBeUndefined();
  });

  it("rejects malformed, overlapping, oversized, and unknown payloads", async () => {
    const core = await loadCore();
    expect(
      core.validatePayload({ version: 2, duration: 1, segments: [] }),
    ).toBeUndefined();
    expect(
      core.validatePayload({
        version: 1,
        duration: 10,
        segments: [
          {
            id: "a",
            type: "intro",
            start: 0,
            end: 6,
            title: "A",
            reason: "policy_kept",
          },
          {
            id: "b",
            type: "outro",
            start: 5,
            end: 8,
            title: "B",
            reason: "policy_kept",
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      core.validatePayload({
        version: 1,
        duration: 10,
        segments: new Array(1025).fill({}),
      }),
    ).toBeUndefined();
  });

  it("keeps automatic behavior opt-in per type", async () => {
    const core = await loadCore();
    const disabled = {
      autoSkipIntro: false,
      autoSkipOutro: false,
      autoSkipRecap: false,
      autoSkipPreview: false,
    };
    expect(core.shouldAutoSkip("intro", disabled)).toBe(false);
    expect(
      core.shouldAutoSkip("intro", { ...disabled, autoSkipIntro: true }),
    ).toBe(true);
    expect(
      core.shouldAutoSkip("outro", { ...disabled, autoSkipIntro: true }),
    ).toBe(false);
    expect(core.requestIsCurrent(2, 2, "cut-a", "cut-a")).toBe(true);
    expect(core.requestIsCurrent(2, 3, "cut-a", "cut-a")).toBe(false);
    expect(core.requestIsCurrent(2, 2, "cut-a", "cut-b")).toBe(false);
    expect(core.shouldRearm({ start: 10 }, 9, 25)).toBe(true);
    expect(core.shouldRearm({ start: 10 }, 15, 25)).toBe(false);
    expect(core.shouldRearm({ start: 10 }, 9, 8)).toBe(false);
    expect(core.SETTINGS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "showButtons",
          type: "toggle",
          defaultValue: true,
        }),
        expect.objectContaining({
          key: "autoSkipIntro",
          type: "toggle",
          defaultValue: false,
        }),
      ]),
    );
  });
});
