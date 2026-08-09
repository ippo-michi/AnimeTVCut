import { describe, expect, it } from "vitest";
import { composeAss, mapSubtitleEvents, parseAss } from "../src/index.js";
const source = (color: string) =>
  `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,50,${color},0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\nStyle: Sign,Arial,45,${color},0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\rSign}Hello {\\r} {\\fnOther}world`;
describe("ASS composition", () => {
  it("namespaces colliding styles and explicit reset styles only", () => {
    const parsed = [
      parseAss(source("&H00FFFFFF"), "e1", 0),
      parseAss(source("&H0000FFFF"), "e2", 1),
    ];
    const pieces = [
      {
        id: "p1",
        sourceEpisodeId: "e1",
        sourceStart: 0,
        sourceEnd: 4,
        outputStart: 0,
        outputEnd: 4,
        kind: "content" as const,
      },
      {
        id: "p2",
        sourceEpisodeId: "e2",
        sourceStart: 0,
        sourceEnd: 4,
        outputStart: 4,
        outputEnd: 8,
        kind: "content" as const,
      },
    ];
    const output = composeAss(
      parsed,
      mapSubtitleEvents(
        parsed.flatMap((item) => item.events),
        pieces,
      ),
    );
    expect(output).toContain("Style: E1_Default");
    expect(output).toContain("Style: E2_Default");
    expect(output).toContain("{\\rE1_Sign}Hello {\\r} {\\fnOther}world");
    expect(output).toContain("Dialogue: 0,0:00:05.00,0:00:07.00,E2_Default");
  });
  it("rejects incompatible geometry", () => {
    const one = parseAss(source("white"), "e1", 0),
      two = parseAss(
        source("white").replace("PlayResX: 1920", "PlayResX: 1280"),
        "e2",
        1,
      );
    expect(() => composeAss([one, two], [])).toThrow(
      "incompatible_ass_geometry",
    );
  });
  it("rejects malformed ASS", () => {
    expect(() => parseAss("[Script Info]\nScriptType: v4.00+", "e", 0)).toThrow(
      "malformed_ass",
    );
  });
});
