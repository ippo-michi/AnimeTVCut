import type { SubtitleSourceFormat } from "@animetvcut/subtitles";
import type { ChapterEpisodeInput } from "./cut-service.js";

export interface JimakuSeries {
  title: string;
  malAnimeId?: number;
  episodes: readonly ChapterEpisodeInput[];
}
interface JimakuFile {
  name: string;
  url: string;
  format: SubtitleSourceFormat;
}
const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Jimaku's file list has no structured episode number. Ignore archives and unrelated numbers. */
export function jimakuFileScore(
  name: string,
  season: number,
  episode: number,
): number {
  const lower = name.toLowerCase();
  if (
    !/\.(ass|ssa|srt|vtt)$/.test(lower) ||
    /(?:^|[\s._[(-])(english|eng|signs?|songs?)(?:[\s._\])-]|$)/i.test(lower)
  )
    return -1;
  const seasonEpisode =
    /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]*e(\d{1,4})(?!\d)/i.exec(lower);
  if (seasonEpisode)
    return Number(seasonEpisode[1]) === season &&
      Number(seasonEpisode[2]) === episode
      ? 120
      : -1;
  const explicit =
    /(?:^|[^a-z0-9])(?:ep(?:isode)?[ ._-]*|e)(\d{1,4})(?!\d)/i.exec(lower);
  const separated = /(?:^|[\s._[(-])(\d{1,4})(?=$|[\s._\])-])/g;
  let matched = explicit ? Number(explicit[1]) === episode : false;
  if (!explicit)
    for (const match of lower.matchAll(separated))
      if (Number(match[1]) === episode) matched = true;
  return matched ? 80 : -1;
}

export class JimakuProvider {
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async json(
    url: string,
    signal?: AbortSignal,
    init?: RequestInit,
  ): Promise<unknown> {
    const response = await this.request(url, {
      ...init,
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok || !response.body)
      throw new Error("jimaku_request_failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) throw new Error("jimaku_response_too_large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }

  private async anilistId(
    malId: number,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    try {
      const data = (await this.json("https://graphql.anilist.co", signal, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          query: "query ($id: Int) { Media(idMal: $id, type: ANIME) { id } }",
          variables: { id: malId },
        }),
      })) as { data?: { Media?: { id?: unknown } } };
      const id = data.data?.Media?.id;
      return typeof id === "number" && Number.isSafeInteger(id) && id > 0
        ? id
        : undefined;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }

  public async find(
    series: JimakuSeries,
    signal?: AbortSignal,
  ): Promise<{ episodeId: string; file: JimakuFile }[]> {
    if (!series.title.trim() || !series.episodes.length) return [];
    const id = series.malAnimeId
      ? await this.anilistId(series.malAnimeId, signal)
      : undefined;
    const search = new URL("https://jimaku.cc/api/entries/search");
    if (id) search.searchParams.set("anilist_id", String(id));
    else search.searchParams.set("query", series.title);
    const headers = { Authorization: this.apiKey, accept: "application/json" };
    const result = await this.json(search.toString(), signal, { headers });
    if (!Array.isArray(result)) return [];
    const title = normalize(series.title);
    const entries = result
      .slice(0, 50)
      .flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object") return [];
        const value = entry as {
          id?: unknown;
          name?: unknown;
          anilist_id?: unknown;
        };
        if (!Number.isSafeInteger(value.id) || typeof value.name !== "string")
          return [];
        const name = normalize(value.name);
        const score = id
          ? value.anilist_id === id
            ? 100
            : 0
          : name === title
            ? 80
            : name.includes(title) || title.includes(name)
              ? 40
              : 10;
        return score && name.length >= 3
          ? [{ id: value.id as number, score }]
          : [];
      })
      .sort((a, b) => b.score - a.score || a.id - b.id)
      .slice(0, 3);
    const files: { file: JimakuFile; entryId: number; entryScore: number }[] =
      [];
    for (const entry of entries) {
      const list = await this.json(
        `https://jimaku.cc/api/entries/${entry.id}/files`,
        signal,
        { headers },
      );
      if (!Array.isArray(list)) continue;
      for (const item of list.slice(0, 3000) as unknown[]) {
        if (
          !item ||
          typeof item !== "object" ||
          !("name" in item) ||
          !("url" in item) ||
          typeof item.name !== "string" ||
          typeof item.url !== "string"
        )
          continue;
        const ext = /\.(ass|ssa|srt|vtt)$/i.exec(item.name)?.[1]?.toLowerCase();
        if (!ext) continue;
        try {
          const url = new URL(item.url);
          if (url.protocol !== "https:" || url.username || url.password)
            continue;
          files.push({
            file: {
              name: item.name,
              url: url.toString(),
              format: ext === "vtt" ? "webvtt" : (ext as SubtitleSourceFormat),
            },
            entryId: entry.id,
            entryScore: entry.score,
          });
        } catch {
          /* invalid provider URL */
        }
      }
    }
    // Prefer styled tracks only when every episode has one; families cannot mix output formats.
    for (const entry of entries)
      for (const styled of [true, false]) {
        const chosen = series.episodes.map((ep) => ({
          ep,
          choices: files
            .filter(
              ({ file }) =>
                (file.format === "ass" || file.format === "ssa") === styled,
            )
            .filter((item) => item.entryId === entry.id)
            .map((item) => ({
              ...item,
              episodeScore: jimakuFileScore(
                item.file.name,
                ep.season,
                ep.episode,
              ),
            }))
            .filter((item) => item.episodeScore >= 0)
            .sort(
              (a, b) =>
                b.entryScore + b.episodeScore - a.entryScore - a.episodeScore ||
                a.file.name.localeCompare(b.file.name),
            ),
        }));
        if (chosen.every(({ choices }) => choices.length))
          return chosen.map(({ ep, choices }) => ({
            episodeId: ep.sourceEpisodeId,
            file: choices[0]!.file,
          }));
      }
    return [];
  }
}
