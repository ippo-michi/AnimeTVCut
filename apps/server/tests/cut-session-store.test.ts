import { describe, expect, it } from "vitest";

import { CutSessionStore } from "../src/services/cut-session-store.js";

function save(store: CutSessionStore) {
  return store.save({
    id: "cut",
    duration: 1,
    playlist: "#EXTM3U",
    pieces: [],
    appliedCuts: [],
    resources: new Map(),
    subtitleTracks: new Map(),
    subtitleDiagnostics: { discoveredPerEpisode: {}, issues: [] },
  });
}

describe("activity-aware cut sessions", () => {
  it("refreshes idle expiry after legitimate touches", () => {
    let now = 0;
    const store = new CutSessionStore({
      idleTtlMilliseconds: 6_000,
      maxLifetimeMilliseconds: 20_000,
      now: () => now,
    });
    save(store);
    now = 5_000;
    expect(store.touch("cut")).toBeDefined();
    now = 10_500;
    expect(store.get("cut")).toBeDefined();
  });

  it("expires an idle session", () => {
    let now = 0;
    const store = new CutSessionStore({
      idleTtlMilliseconds: 6_000,
      maxLifetimeMilliseconds: 20_000,
      now: () => now,
    });
    save(store);
    now = 6_001;
    expect(store.get("cut")).toBeUndefined();
  });

  it("expires at absolute lifetime despite regular touches", () => {
    let now = 0;
    const store = new CutSessionStore({
      idleTtlMilliseconds: 6_000,
      maxLifetimeMilliseconds: 12_000,
      now: () => now,
    });
    save(store);
    now = 5_000;
    store.touch("cut");
    now = 10_000;
    store.touch("cut");
    now = 12_001;
    expect(store.get("cut")).toBeUndefined();
  });

  it("does not create or refresh sessions for invalid IDs", () => {
    let now = 0;
    const store = new CutSessionStore({
      idleTtlMilliseconds: 1_000,
      maxLifetimeMilliseconds: 5_000,
      now: () => now,
    });
    save(store);
    now = 900;
    expect(store.touch("unknown")).toBeUndefined();
    now = 1_001;
    expect(store.get("cut")).toBeUndefined();
  });

  it("supports a simulated long playback until the absolute ceiling", () => {
    let now = 0;
    const store = new CutSessionStore({
      idleTtlMilliseconds: 6_000,
      maxLifetimeMilliseconds: 20_000,
      now: () => now,
    });
    save(store);
    for (const access of [5_000, 10_000, 15_000, 19_000]) {
      now = access;
      expect(store.touch("cut")).toBeDefined();
    }
    now = 19_999;
    expect(store.get("cut")).toBeDefined();
    now = 20_000;
    expect(store.get("cut")).toBeUndefined();
  });
});
