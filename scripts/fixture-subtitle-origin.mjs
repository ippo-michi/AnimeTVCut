import { createServer } from "node:http";

const port = Number.parseInt(process.env.FIXTURE_SUBTITLE_PORT ?? "8093", 10);
const counts = { total: 0, active: 0, maxActive: 0, byEpisodeLanguage: {} };
function marker(episode, section) {
  return episode <= 6
    ? `E${episode}-${section}`
    : `S2E${episode - 6}-${section}`;
}
function srt(episode) {
  return `1\n00:00:02,000 --> 00:00:03,000\n${marker(episode, "OPENING")}\n\n2\n00:00:08,000 --> 00:00:10,000\n${marker(episode, "STORY-A")}\n\n3\n00:00:22,000 --> 00:00:23,000\n${marker(episode, "STORY-B")}\n\n4\n00:00:26,000 --> 00:00:28,000\n${marker(episode, "ENDING")}\n`;
}
function vtt(episode) {
  return `WEBVTT\n\n00:00:02.000 --> 00:00:03.000\n${marker(episode, "OUVERTURE")}\n\n00:00:08.000 --> 00:00:10.000\n${marker(episode, "HISTOIRE-A")}\n\n00:00:22.000 --> 00:00:23.000\n${marker(episode, "HISTOIRE-B")}\n\n00:00:26.000 --> 00:00:28.000\n${marker(episode, "FIN")}\n`;
}
function ass(episode) {
  const color = episode % 2 === 0 ? "&H0000FFFF" : "&H00FFFFFF";
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 180\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,18,${color},&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\nStyle: Sign,Arial,16,${color},&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,1,0,8,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,${marker(episode, "OP-JPN")}\nDialogue: 0,0:00:08.00,0:00:10.00,Default,,0,0,0,,{\\rSign}${marker(episode, "STORY-JPN")}\nDialogue: 0,0:00:22.00,0:00:23.00,Sign,,0,0,0,,${marker(episode, "STORY-SIGN-JPN")}\nDialogue: 0,0:00:26.00,0:00:28.00,Default,,0,0,0,,${marker(episode, "ED-JPN")}\n`;
}
function json(response, value) {
  const body = JSON.stringify(value);
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture-subtitles");
  if (url.pathname === "/health") return json(response, { status: "ok" });
  if (url.pathname === "/stats") return json(response, counts);
  const match = /^\/episode(1[0-2]|[1-9])\.(eng\.srt|fra\.vtt|jpn\.ass)$/.exec(
    url.pathname,
  );
  if (match === null) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  const episode = Number(match[1]),
    language = match[2].split(".")[0];
  counts.total += 1;
  counts.active += 1;
  counts.maxActive = Math.max(counts.maxActive, counts.active);
  const key = `e${episode}-${language}`;
  counts.byEpisodeLanguage[key] = (counts.byEpisodeLanguage[key] ?? 0) + 1;
  const body =
    language === "eng"
      ? srt(episode)
      : language === "fra"
        ? vtt(episode)
        : ass(episode);
  globalThis.setTimeout(() => {
    response.writeHead(200, {
      "content-type":
        language === "fra"
          ? "text/vtt; charset=utf-8"
          : "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
    counts.active -= 1;
  }, 25);
});
server.listen(port, "0.0.0.0", () =>
  process.stdout.write(`fixture subtitle origin listening on ${port}\n`),
);
