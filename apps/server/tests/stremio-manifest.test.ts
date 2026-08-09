import { describe, expect, it } from "vitest";

import {
  assertManifestSupportsReference,
  buildStreamResourceUrl,
  parseStremioManifest,
} from "../src/services/stremio-upstream/manifest.js";
import { redactManifestUrl } from "../src/services/stremio-upstream/redaction.js";

const manifestObject = {
  id: "org.example.addon",
  name: "AIOStreams",
  version: "1.2.3",
  types: ["series"],
  idPrefixes: ["tt"],
  resources: ["stream"],
};

describe("Stremio manifest handling", () => {
  it("redacts the complete authenticated manifest path and query", () => {
    expect(
      redactManifestUrl(
        "https://aiostreams.example/stremio/user/secret/manifest.json?token=hidden",
      ),
    ).toBe("https://aiostreams.example/<redacted-manifest-path>");
  });

  it("parses string stream resources and manifest-level constraints", () => {
    expect(parseStremioManifest(manifestObject)).toMatchObject({
      name: "AIOStreams",
      resources: [{ name: "stream" }],
      types: ["series"],
      idPrefixes: ["tt"],
    });
  });

  it("supports object stream resources and resource-level constraints", () => {
    const manifest = parseStremioManifest({
      ...manifestObject,
      types: ["movie"],
      idPrefixes: ["kitsu"],
      resources: [{ name: "stream", types: ["series"], idPrefixes: ["tt"] }],
    });
    expect(() =>
      assertManifestSupportsReference(manifest, {
        episodeId: "ep1",
        type: "series",
        videoId: "tt1234567:1:1",
      }),
    ).not.toThrow();
  });

  it("rejects a manifest without stream support", () => {
    expect(() =>
      parseStremioManifest({ ...manifestObject, resources: ["meta"] }),
    ).toThrow(/does not support stream/);
  });

  it("rejects incompatible types", () => {
    const manifest = parseStremioManifest(manifestObject);
    expect(() =>
      assertManifestSupportsReference(manifest, {
        episodeId: "ep1",
        type: "movie",
        videoId: "tt1234567",
      }),
    ).toThrow(/does not support movie/);
  });

  it("rejects incompatible ID prefixes but treats absent prefixes as unrestricted", () => {
    const restricted = parseStremioManifest(manifestObject);
    expect(() =>
      assertManifestSupportsReference(restricted, {
        episodeId: "ep1",
        type: "series",
        videoId: "kitsu:1234:1",
      }),
    ).toThrow(/does not support series/);

    const unrestricted = parseStremioManifest({
      ...manifestObject,
      idPrefixes: undefined,
    });
    expect(() =>
      assertManifestSupportsReference(unrestricted, {
        episodeId: "ep1",
        type: "series",
        videoId: "kitsu:1234:1",
      }),
    ).not.toThrow();
  });

  it("preserves the authenticated addon path and encodes resource path segments", () => {
    const url = buildStreamResourceUrl(
      new URL("https://host.test/stremio/test-user/test-secret/manifest.json"),
      {
        episodeId: "ep2",
        type: "series-special",
        videoId: "tt1234567:1:2_extra",
      },
    );
    expect(url.toString()).toBe(
      "https://host.test/stremio/test-user/test-secret/stream/series-special/tt1234567%3A1%3A2_extra.json",
    );
  });

  it("preserves an authenticated manifest query on derived resources", () => {
    const url = buildStreamResourceUrl(
      new URL("https://host.test/addon/manifest.json?token=secret"),
      { episodeId: "ep1", type: "series", videoId: "id:1" },
    );
    expect(url.toString()).toBe(
      "https://host.test/addon/stream/series/id%3A1.json?token=secret",
    );
  });
});
