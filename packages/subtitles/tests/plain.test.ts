import { describe, expect, it } from "vitest";
import {
  composeWebVtt,
  decodeSubtitleBytes,
  parseSrt,
  parseWebVtt,
} from "../src/index.js";

describe("plain subtitle formats", () => {
  it("parses CRLF, BOM, missing sequence numbers, multiline and overlaps", () => {
    const parsed = parseSrt(
      "\uFEFF1\r\n00:00:01,000 --> 00:00:03,000\r\nFirst\r\nline\r\n\r\n00:00:02.500 --> 00:00:04.000\r\nOverlap",
      "e1",
      0,
    );
    expect(
      parsed.events.map((event) => [event.start, event.end, event.text]),
    ).toEqual([
      [1, 3, "First\nline"],
      [2.5, 4, "Overlap"],
    ]);
    expect(composeWebVtt(parsed.events)).toContain(
      "00:00:02.500 --> 00:00:04.000",
    );
  });
  it("parses VTT IDs/settings and ignores NOTE/STYLE", () => {
    const parsed = parseWebVtt(
      "WEBVTT\n\nNOTE ignored\nline\n\nSTYLE\n::cue { color: red }\n\nid-a\n00:00:01.000 --> 00:00:02.000 align:start\nHello",
      "e",
      0,
    );
    expect(parsed.events[0]).toMatchObject({
      cueId: "id-a",
      settings: "align:start",
      text: "Hello",
    });
  });
  it("supports required BOM encodings and rejects invalid UTF-8", () => {
    expect(decodeSubtitleBytes(Uint8Array.from([0xff, 0xfe, 0x41, 0x00]))).toBe(
      "A",
    );
    expect(decodeSubtitleBytes(Uint8Array.from([0xfe, 0xff, 0x00, 0x41]))).toBe(
      "A",
    );
    expect(() => decodeSubtitleBytes(Uint8Array.from([0xc3, 0x28]))).toThrow(
      "unsupported_encoding",
    );
  });
  it("detects UTF-16 subtitle structure", async () => {
    const { detectSubtitleFormat } = await import("../src/index.js");
    const utf16 = new TextEncoder().encode("WEBVTT");
    const bytes = Uint8Array.from([
      0xff,
      0xfe,
      ...Array.from(utf16).flatMap((byte) => [byte, 0]),
    ]);
    expect(detectSubtitleFormat(bytes)).toBe("webvtt");
  });
  it("rejects malformed SRT and WebVTT", () => {
    expect(() => parseSrt("not subtitles", "e", 0)).toThrow("malformed_srt");
    expect(() => parseWebVtt("WEBVTT\n\nnot a cue", "e", 0)).toThrow(
      "malformed_vtt",
    );
  });
});
