import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parseHlsVodPlaylist, type HlsVodPlaylist } from "@animetvcut/hls";

const FIXTURE_DIRECTORIES: Readonly<Record<string, string>> = {
  episode1: "episode1",
  episode2: "episode2",
  episode3: "episode3",
};

export interface FixtureResource {
  localPath: string;
  size: number;
}

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
    throw new Error("Only credential-free fixture:// source URLs are supported");
  }
  if (FIXTURE_DIRECTORIES[url.hostname] === undefined) {
    throw new Error(`Unknown fixture source: ${url.hostname}`);
  }
  return url;
}

export class FixtureSourceLoader {
  public constructor(private readonly fixtureRoot: string) {}

  public async loadPlaylist(rawUrl: string): Promise<HlsVodPlaylist> {
    const url = parseSafeFixtureUrl(rawUrl);
    if (url.pathname !== "" && url.pathname !== "/") {
      throw new Error("Fixture playlist URLs must not contain a path");
    }
    const directory = FIXTURE_DIRECTORIES[url.hostname];
    if (directory === undefined) {
      throw new Error("Unknown fixture source");
    }
    const playlistPath = path.join(this.fixtureRoot, directory, "playlist.m3u8");
    const text = await readFile(playlistPath, "utf8");
    return parseHlsVodPlaylist(text, `${url.toString().replace(/\/$/, "")}/playlist.m3u8`);
  }

  public async resolveResource(rawUrl: string): Promise<FixtureResource> {
    const url = parseSafeFixtureUrl(rawUrl);
    const directoryName = FIXTURE_DIRECTORIES[url.hostname];
    if (directoryName === undefined || url.pathname === "" || url.pathname === "/") {
      throw new Error("Fixture resource path is missing");
    }
    const directory = path.resolve(this.fixtureRoot, directoryName);
    const localPath = path.resolve(directory, `.${decodeURIComponent(url.pathname)}`);
    if (!localPath.startsWith(`${directory}${path.sep}`)) {
      throw new Error("Fixture resource path escapes its fixture directory");
    }
    const metadata = await stat(localPath);
    if (!metadata.isFile()) {
      throw new Error("Fixture resource is not a file");
    }
    return { localPath, size: metadata.size };
  }
}
