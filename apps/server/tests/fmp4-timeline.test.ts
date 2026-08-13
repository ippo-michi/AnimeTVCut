import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  MediaFlowTimelineTransform,
  rewriteMediaFlowMoofTimeline,
} from "../src/services/mediaflow/fmp4-timeline.js";

function box(type: string, ...payloads: Buffer[]): Buffer {
  const payload = Buffer.concat(payloads);
  const output = Buffer.alloc(8 + payload.length);
  output.writeUInt32BE(output.length, 0);
  output.write(type, 4, 4, "ascii");
  payload.copy(output, 8);
  return output;
}

function fullBox(type: string, version: number, payload: Buffer): Buffer {
  return box(type, Buffer.from([version, 0, 0, 0]), payload);
}

function traf(trackId: number, decodeTime: bigint): Buffer {
  const tfhd = Buffer.alloc(4);
  tfhd.writeUInt32BE(trackId);
  const tfdt = Buffer.alloc(8);
  tfdt.writeBigUInt64BE(decodeTime);
  return box("traf", fullBox("tfhd", 0, tfhd), fullBox("tfdt", 1, tfdt));
}

function readTfdt(moof: Buffer, trafIndex: number): bigint {
  let offset = 8;
  let found = 0;
  while (offset < moof.length) {
    const size = moof.readUInt32BE(offset);
    if (moof.toString("ascii", offset + 4, offset + 8) === "traf") {
      if (found === trafIndex) {
        let child = offset + 8;
        while (child < offset + size) {
          const childSize = moof.readUInt32BE(child);
          if (moof.toString("ascii", child + 4, child + 8) === "tfdt")
            return moof.readBigUInt64BE(child + 12);
          child += childSize;
        }
      }
      found += 1;
    }
    offset += size;
  }
  throw new Error("tfdt missing");
}

describe("MediaFlow fMP4 timeline rebasing", () => {
  it("rebases video and audio decode clocks by their track timescales", () => {
    const source = box("moof", traf(1, 540_000n), traf(2, 288_000n));
    const rewritten = rewriteMediaFlowMoofTimeline(source, -4);
    expect(readTfdt(rewritten, 0)).toBe(180_000n);
    expect(readTfdt(rewritten, 1)).toBe(96_000n);
    expect(readTfdt(source, 0)).toBe(540_000n);
  });

  it("streams mdat bytes unchanged while handling split moof chunks", async () => {
    const moof = box("moof", traf(1, 0n), traf(2, 0n));
    const media = box("mdat", Buffer.from("encoded-media-payload"));
    const chunks = [
      moof.subarray(0, 5),
      moof.subarray(5, 19),
      Buffer.concat([moof.subarray(19), media.subarray(0, 10)]),
      media.subarray(10),
    ];
    const output: Buffer[] = [];
    for await (const chunk of Readable.from(chunks).pipe(
      new MediaFlowTimelineTransform(12),
    ))
      output.push(chunk as Buffer);
    const combined = Buffer.concat(output);
    expect(readTfdt(combined.subarray(0, moof.length), 0)).toBe(1_080_000n);
    expect(readTfdt(combined.subarray(0, moof.length), 1)).toBe(576_000n);
    expect(combined.subarray(moof.length)).toEqual(media);
    expect(combined).toHaveLength(moof.length + media.length);
  });
});
