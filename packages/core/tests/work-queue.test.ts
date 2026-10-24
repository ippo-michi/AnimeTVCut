import { describe, expect, it, vi } from "vitest";

import { WorkQueue } from "../src/work-queue.js";

describe("bounded work", () => {
  it("overlaps work within its budget and never starts cancelled queued work", async () => {
    const queue = new WorkQueue(2);
    const releases: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    const work = () =>
      queue.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      });
    const first = work();
    const second = work();
    const controller = new AbortController();
    const cancelledWork = vi.fn(async () => {});
    const cancelled = queue.run(cancelledWork, controller.signal);
    const rejection = expect(cancelled).rejects.toThrow();
    const last = work();
    controller.abort();
    await rejection;
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(peak).toBe(2);
    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[1]!();
    releases[2]!();
    await Promise.all([first, second, last]);
    expect(cancelledWork).not.toHaveBeenCalled();
    expect(peak).toBe(2);
  });
});
