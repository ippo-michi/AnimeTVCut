import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("durable cut sessions", () => {
  it("serves the exact same playlist, range bytes, and chapters after a restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "atc-recovery-"));
    const first = createApp({ sessionDirectory: directory });
    let second: ReturnType<typeof createApp> | undefined;
    try {
      const created = await first.inject({
        method: "POST",
        url: "/api/v1/dev/cuts",
        payload: {
          sources: [{ episodeId: "ep1", playlistUrl: "fixture://episode1" }],
          remove: [],
        },
      });
      expect(created.statusCode).toBe(200);
      const { cutId, playlistUrl } = created.json<{
        cutId: string;
        playlistUrl: string;
      }>();
      const playlist = await first.inject(playlistUrl);
      const segmentUrl = playlist.body
        .split("\n")
        .find((line) => line.startsWith("/media/cut/"))!;
      const segment = await first.inject({
        url: segmentUrl,
        headers: { range: "bytes=0-187" },
      });
      await first.close();
      second = createApp({ sessionDirectory: directory });
      expect((await second.inject(playlistUrl)).body).toBe(playlist.body);
      const restored = await second.inject({
        url: segmentUrl,
        headers: { range: "bytes=0-187" },
      });
      expect(restored.statusCode).toBe(206);
      expect(restored.rawPayload).toEqual(segment.rawPayload);
      expect(
        (await second.inject(`/media/cut/${cutId}/chapters.json`)).statusCode,
      ).toBe(200);
      expect(
        (await stat(path.join(directory, `${cutId}.json`))).mode & 0o777,
      ).toBe(0o600);
      const snapshot = await readFile(
        path.join(directory, `${cutId}.json`),
        "utf8",
      );
      expect(snapshot).not.toContain('"open"');
    } finally {
      await first.close();
      await second?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("discards corrupt and expired snapshots without reviving a cut", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "atc-expiry-"));
    let now = 1000;
    const first = createApp({
      sessionDirectory: directory,
      sessionTtlMilliseconds: 100,
      now: () => now,
    });
    try {
      const created = await first.inject({
        method: "POST",
        url: "/api/v1/dev/cuts",
        payload: {
          sources: [{ episodeId: "ep1", playlistUrl: "fixture://episode1" }],
          remove: [],
        },
      });
      const { playlistUrl } = created.json<{ playlistUrl: string }>();
      await first.close();
      await writeFile(path.join(directory, "corrupt.json"), "{broken");
      now = 1200;
      const second = createApp({ sessionDirectory: directory, now: () => now });
      try {
        expect((await second.inject(playlistUrl)).statusCode).toBe(404);
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
