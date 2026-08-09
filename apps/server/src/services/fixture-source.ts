import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parseHlsVodPlaylist, type HlsVodPlaylist } from "@animetvcut/hls";

import type {
  FixtureHlsSource,
  HlsResolvedResource,
  HlsSourceLoader,
  LazyMediaResource,
  MediaInputSource,
  OpenedMediaResource,
} from "./hls-source-loader.js";
import { MediaRangeNotSatisfiableError } from "./hls-source-loader.js";

const FIXTURE_DIRECTORIES: Readonly<Record<string, string>> = {
  episode1: "episode1",
  episode2: "episode2",
  episode3: "episode3",
  "fmp4-episode1": "fmp4-episode1",
  "fmp4-episode2": "fmp4-episode2",
  "fmp4-episode3": "fmp4-episode3",
};

function parseSafeFixtureUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Source URL is invalid");
  }
  if (
    url.protocol !== "fixture:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Only credential-free fixture:// source URLs are supported",
    );
  }
  if (FIXTURE_DIRECTORIES[url.hostname] === undefined) {
    throw new Error(`Unknown fixture source: ${url.hostname}`);
  }
  return url;
}

export class FixtureSourceLoader implements HlsSourceLoader {
  public constructor(private readonly fixtureRoot: string) {}

  public async loadPlaylist(source: MediaInputSource): Promise<HlsVodPlaylist> {
    this.assertFixtureSource(source);
    const url = parseSafeFixtureUrl(source.playlistUrl);
    if (url.pathname !== "" && url.pathname !== "/") {
      throw new Error("Fixture playlist URLs must not contain a path");
    }
    const directory = FIXTURE_DIRECTORIES[url.hostname];
    if (directory === undefined) {
      throw new Error("Unknown fixture source");
    }
    const playlistPath = path.join(
      this.fixtureRoot,
      directory,
      "playlist.m3u8",
    );
    const text = await readFile(playlistPath, "utf8");
    return parseHlsVodPlaylist(
      text,
      `${url.toString().replace(/\/$/, "")}/playlist.m3u8`,
    );
  }

  public createResource(resolved: HlsResolvedResource): LazyMediaResource {
    this.assertFixtureSource(resolved.source);
    const url = parseSafeFixtureUrl(resolved.resource.absoluteUri);
    const directoryName = FIXTURE_DIRECTORIES[url.hostname];
    if (
      directoryName === undefined ||
      url.pathname === "" ||
      url.pathname === "/"
    ) {
      throw new Error("Fixture resource path is missing");
    }
    const directory = path.resolve(this.fixtureRoot, directoryName);
    const localPath = path.resolve(
      directory,
      `.${decodeURIComponent(url.pathname)}`,
    );
    if (!localPath.startsWith(`${directory}${path.sep}`)) {
      throw new Error("Fixture resource path escapes its fixture directory");
    }
    return {
      contentType: resolved.resource.contentType,
      open: async (range): Promise<OpenedMediaResource> => {
        const metadata = await stat(localPath);
        if (!metadata.isFile()) {
          throw new Error("Fixture resource is not a file");
        }
        if (range === undefined) {
          return {
            statusCode: 200,
            contentType: resolved.resource.contentType,
            contentLength: metadata.size,
            responseHeaders: {
              "accept-ranges": "bytes",
              "content-length": String(metadata.size),
            } satisfies Record<string, string>,
            stream: createReadStream(localPath),
          };
        }
        const end = range.end ?? metadata.size - 1;
        if (
          !Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(end) ||
          range.start < 0 ||
          range.start >= metadata.size ||
          end < range.start ||
          end >= metadata.size
        ) {
          throw new MediaRangeNotSatisfiableError(metadata.size);
        }
        return {
          statusCode: 206,
          contentType: resolved.resource.contentType,
          contentLength: end - range.start + 1,
          responseHeaders: {
            "accept-ranges": "bytes",
            "content-length": String(end - range.start + 1),
            "content-range": `bytes ${range.start}-${end}/${metadata.size}`,
          } satisfies Record<string, string>,
          stream: createReadStream(localPath, { start: range.start, end }),
        };
      },
    };
  }

  private assertFixtureSource(
    source: MediaInputSource,
  ): asserts source is FixtureHlsSource {
    if (source.kind !== "fixture_hls") {
      throw new Error("Fixture source loader only accepts fixture_hls sources");
    }
  }
}
