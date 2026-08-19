import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { MetadataStremioClient } from "@animetvcut/stremio";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const BASE_PATH = "/metadata/test-user/metadata-secret";
const AUTH_QUERY = "auth_token=topsecret-abc123";
const CATALOG_ID = "fixture-series-primary";

type MetadataMode = "ok" | "catalog-500" | "invalid-json" | "hang";

const manifest = {
  id: "fake.metadata.addon",
  name: "Fake AIOMetadata",
  version: "1.0.0",
  types: ["series"],
  resources: ["catalog", "meta"],
  catalogs: [
    {
      id: CATALOG_ID,
      type: "series",
      name: "Fixture Series",
      extra: [{ name: "search", isRequired: true }],
    },
  ],
};

const previews = [
  {
    id: "fake:frieren:journey",
    type: "series",
    name: "Frieren: Beyond Journey's End",
    poster: "https://images.test/frieren.jpg",
  },
  {
    id: "fake:frieren:special",
    type: "series",
    name: "Frieren Special",
    poster: "https://images.test/frieren-special.jpg",
  },
  {
    id: "fake:frieren:movie",
    type: "series",
    name: "Frieren Movie",
    poster: "https://images.test/frieren-movie.jpg",
  },
];

class FakeMetadataAddon {
  public readonly requests: Array<{ method: string; url: string }> = [];
  public mode: MetadataMode = "ok";
  private readonly server = createServer((request, response) =>
    this.handle(request, response),
  );

  private constructor() {}

  public static async start(): Promise<FakeMetadataAddon> {
    const addon = new FakeMetadataAddon();
    await new Promise<void>((resolve, reject) => {
      addon.server.once("error", reject);
      addon.server.listen(0, "127.0.0.1", () => {
        addon.server.removeListener("error", reject);
        resolve();
      });
    });
    return addon;
  }

  public get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Fake metadata addon is not listening.");
    }
    return address.port;
  }

  public get manifestUrl(): string {
    return `http://127.0.0.1:${this.port}${BASE_PATH}/manifest.json?${AUTH_QUERY}`;
  }

  public async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private respond(
    response: ServerResponse,
    statusCode: number,
    value: unknown,
  ): void {
    const body = JSON.stringify(value);
    response.writeHead(statusCode, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    response.on("error", () => {
      // The metadata client may abort mid-response (timeout scenarios).
    });
    this.requests.push({
      method: request.method ?? "GET",
      url: request.url ?? "",
    });
    const url = new URL(request.url ?? "/", "http://fake-metadata");
    if (url.pathname === `${BASE_PATH}/manifest.json`) {
      this.respond(response, 200, manifest);
      return;
    }
    if (
      url.pathname.startsWith(`${BASE_PATH}/catalog/series/`) &&
      url.pathname.endsWith(".json")
    ) {
      if (this.mode === "catalog-500") {
        this.respond(response, 500, { error: "metadata exploded" });
        return;
      }
      if (this.mode === "invalid-json") {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": "28",
        });
        response.end("{ this is not valid json !!!");
        return;
      }
      if (this.mode === "hang") {
        // Never respond. The metadata client's own timeout must bound this.
        return;
      }
      this.respond(response, 200, { metas: previews });
      return;
    }
    this.respond(response, 404, { error: "not found" });
  }
}

describe("public catalog search over real HTTP", () => {
  const apps: ReturnType<typeof createApp>[] = [];
  const addons: FakeMetadataAddon[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
    await Promise.all(addons.splice(0).map(async (addon) => addon.close()));
  });

  async function startApp(addon: FakeMetadataAddon) {
    const app = createApp({
      metadataClient: new MetadataStremioClient({
        manifestUrl: addon.manifestUrl,
        requestTimeoutMs: 1_000,
        manifestCacheTtlMs: 300_000,
        catalogCacheTtlMs: 300_000,
        metaCacheTtlMs: 300_000,
      }),
      publicBaseUrl: new URL("http://127.0.0.1:13005/"),
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    apps.push(app);
    const port = (app.server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  it("serves a real search against a live metadata addon over HTTP", async () => {
    const addon = await FakeMetadataAddon.start();
    addons.push(addon);
    const base = await startApp(addon);

    const started = Date.now();
    const response = await fetch(
      `${base}/v2/catalog/series/animetvcut-v2/search=Frieren.json`,
    );
    const elapsed = Date.now() - started;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      metas: Array<{ id: string; name: string; type: string }>;
    };
    expect(Array.isArray(body.metas)).toBe(true);
    expect(body.metas.length).toBeGreaterThan(0);
    const ids = body.metas.map((meta) => meta.id);
    expect(ids.some((id) => id.startsWith("atc:tv:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("atc:season:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("atc:series:"))).toBe(true);
    for (const meta of body.metas) {
      expect(meta.type).toBe("series");
      expect(typeof meta.name).toBe("string");
    }
    // Request finishes promptly against a real socket.
    expect(elapsed).toBeLessThan(10_000);

    // Metadata manifest requested correctly with the authenticated
    // path/query preserved.
    const manifestRequests = addon.requests.filter((request) =>
      request.url.startsWith(`${BASE_PATH}/manifest.json`),
    );
    expect(manifestRequests.length).toBeGreaterThan(0);
    expect(
      manifestRequests.some((request) =>
        request.url.startsWith(`${BASE_PATH}/manifest.json?${AUTH_QUERY}`),
      ),
    ).toBe(true);

    // Metadata catalog URL generated correctly from the manifest base.
    const catalogRequests = addon.requests.filter((request) =>
      request.url.includes("/catalog/series/"),
    );
    expect(catalogRequests.length).toBeGreaterThan(0);
    expect(
      catalogRequests.some(
        (request) =>
          request.url ===
          `${BASE_PATH}/catalog/series/${CATALOG_ID}/search=Frieren.json?${AUTH_QUERY}`,
      ),
    ).toBe(true);

    // No watch-progress request occurs during catalog search.
    expect(
      addon.requests.some((request) => request.url.includes("/subtitles/")),
    ).toBe(false);
    expect(addon.requests.every((request) => request.method === "GET")).toBe(
      true,
    );
  });

  it.each([
    ["a 500 response", "catalog-500" as const],
    ["invalid JSON", "invalid-json" as const],
    ["a never-responding catalog", "hang" as const],
  ])(
    "still returns HTTP 200 {metas:[]} when the metadata catalog returns %s",
    async (_label, mode) => {
      const addon = await FakeMetadataAddon.start();
      addons.push(addon);
      addon.mode = mode;
      const base = await startApp(addon);

      const started = Date.now();
      const response = await fetch(
        `${base}/v2/catalog/series/animetvcut-v2/search=Frieren.json`,
      );
      const elapsed = Date.now() - started;

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ metas: [] });
      // Must complete within its own deadline rather than hanging on the
      // unreachable metadata backend.
      expect(elapsed).toBeLessThan(10_000);
    },
  );
});
