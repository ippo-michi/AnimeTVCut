import type { Readable } from "node:stream";

import type { FastifyPluginAsync } from "fastify";

import type {
  CutSession,
  CutSessionStore,
  SessionResource,
} from "../services/cut-session-store.js";
import {
  MediaRangeNotSatisfiableError,
  type MediaReadRange,
} from "../services/hls-source-loader.js";
import { MediaFlowError } from "../services/mediaflow/errors.js";
import type { SubtitleService } from "../services/subtitle-service.js";

interface MediaParams {
  cutId: string;
  resourceId: string;
}

const SAFE_RESPONSE_HEADERS = new Set([
  "accept-ranges",
  "cache-control",
  "content-length",
  "content-range",
]);

const prefetchInFlight = new WeakMap<SessionResource, Promise<void>>();
const prefetchedResources = new WeakSet<SessionResource>();

function beginPrefetch(resource: SessionResource): void {
  if (prefetchedResources.has(resource) || prefetchInFlight.has(resource))
    return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const task = (async () => {
    let stream: Readable | undefined;
    try {
      const opened = await resource.open(undefined, controller.signal);
      stream = opened.stream;
      for await (const chunk of opened.stream) {
        void chunk;
        // Drain only to warm MediaFlow's bounded derived-resource cache.
      }
      prefetchedResources.add(resource);
    } catch {
      // Prefetch is opportunistic; the normal player request remains
      // authoritative and reports any real upstream error.
    } finally {
      clearTimeout(timeout);
      stream?.destroy();
      prefetchInFlight.delete(resource);
    }
  })();
  prefetchInFlight.set(resource, task);
}

function prefetchAfter(
  session: CutSession,
  current: SessionResource,
  count: number,
): void {
  if (count <= 0) return;
  let foundCurrent = false;
  let remaining = count;
  for (const resource of session.resources.values()) {
    if (!foundCurrent) {
      foundCurrent = resource === current;
      continue;
    }
    beginPrefetch(resource);
    remaining -= 1;
    if (remaining === 0) return;
  }
}

function parseRange(header: string): MediaReadRange | undefined {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const start = Number.parseInt(match[1], 10);
  const end =
    match[2] === "" || match[2] === undefined
      ? undefined
      : Number.parseInt(match[2], 10);
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    (end !== undefined && (!Number.isSafeInteger(end) || end < start))
  ) {
    return undefined;
  }
  return end === undefined ? { start } : { start, end };
}

function responseContainsWholeResource(
  statusCode: 200 | 206,
  headers: Readonly<Record<string, string>>,
): boolean {
  if (statusCode === 200) return true;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
    headers["content-range"] ?? "",
  );
  if (match === null) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    Number.isSafeInteger(total) &&
    start === 0 &&
    end + 1 === total
  );
}

export function mediaRoutes(
  sessions: CutSessionStore,
  subtitles?: SubtitleService,
  prefetchResourceCount = 0,
): FastifyPluginAsync {
  if (
    !Number.isSafeInteger(prefetchResourceCount) ||
    prefetchResourceCount < 0 ||
    prefetchResourceCount > 8
  ) {
    throw new Error("Media prefetch resource count must be between 0 and 8.");
  }
  return async (app) => {
    app.get<{ Params: Pick<MediaParams, "cutId"> }>(
      "/media/cut/:cutId/master.m3u8",
      async (request, reply) => {
        const session = sessions.touch(request.params.cutId);
        if (session === undefined) {
          return reply
            .code(404)
            .send({ error: "Cut session is missing or expired" });
        }
        return reply
          .type("application/vnd.apple.mpegurl")
          .send(session.playlist);
      },
    );

    app.get<{ Params: MediaParams }>(
      "/media/cut/:cutId/segment/:resourceId",
      async (request, reply) => {
        const session = sessions.get(request.params.cutId);
        const resource = session?.resources.get(request.params.resourceId);
        if (session === undefined || resource === undefined) {
          return reply
            .code(404)
            .send({ error: "Cut resource is missing or expired" });
        }

        const rangeHeader = request.headers.range;
        const range =
          rangeHeader === undefined ? undefined : parseRange(rangeHeader);
        if (rangeHeader !== undefined && range === undefined) {
          return reply.code(416).send({ error: "Invalid byte range" });
        }

        const controller = new AbortController();
        const cancel = () => controller.abort();
        request.raw.once("aborted", cancel);
        reply.raw.once("close", cancel);

        try {
          const pendingPrefetch = prefetchInFlight.get(resource);
          if (pendingPrefetch !== undefined) await pendingPrefetch;
          const opened = await resource.open(range, controller.signal);
          sessions.touch(request.params.cutId);
          prefetchAfter(session, resource, prefetchResourceCount);
          reply.code(opened.statusCode).type(resource.contentType);
          for (const [name, value] of Object.entries(opened.responseHeaders)) {
            const normalized = name.toLowerCase();
            if (SAFE_RESPONSE_HEADERS.has(normalized)) {
              reply.header(normalized, value);
            }
          }
          if (
            opened.contentLength !== undefined &&
            opened.responseHeaders["content-length"] === undefined
          ) {
            reply.header("content-length", opened.contentLength);
          }
          return reply.send(opened.stream);
        } catch (error) {
          if (error instanceof MediaRangeNotSatisfiableError) {
            if (error.contentLength !== undefined) {
              reply.header("content-range", `bytes */${error.contentLength}`);
            }
            return reply.code(416).send({ error: "Invalid byte range" });
          }
          if (controller.signal.aborted) {
            return reply.code(499).send({ error: "Media request cancelled" });
          }
          if (error instanceof MediaFlowError) {
            return reply.code(502).send({ error: error.message });
          }
          return reply
            .code(502)
            .send({ error: "Media resource could not be opened" });
        }
      },
    );

    app.get<{ Params: { cutId: string } }>(
      "/media/cut/:cutId/chapters.json",
      async (request, reply) => {
        const session = sessions.get(request.params.cutId);
        if (session === undefined)
          return reply
            .code(404)
            .send({ error: "Cut session is missing or expired" });
        sessions.touch(request.params.cutId);
        return reply.send({
          duration: session.duration,
          chapters: session.chapters ?? [],
        });
      },
    );

    app.options<{ Params: { cutId: string } }>(
      "/media/cut/:cutId/segments.json",
      async (_request, reply) =>
        reply
          .header("access-control-allow-origin", "*")
          .header("access-control-allow-methods", "GET, OPTIONS")
          .header("access-control-allow-headers", "Accept")
          .code(204)
          .send(),
    );

    app.get<{ Params: { cutId: string } }>(
      "/media/cut/:cutId/segments.json",
      async (request, reply) => {
        const session = sessions.get(request.params.cutId);
        if (session === undefined)
          return reply
            .header("access-control-allow-origin", "*")
            .code(404)
            .send({ error: "Cut session is missing or expired" });
        sessions.touch(request.params.cutId);
        return reply
          .header("access-control-allow-origin", "*")
          .header("cache-control", "private, max-age=300")
          .send({
            version: 1,
            duration: session.duration,
            segments: session.outputSkipSegments,
          });
      },
    );

    app.get<{ Params: { cutId: string; trackFile: string } }>(
      "/media/cut/:cutId/subtitle/:trackFile",
      async (request, reply) => {
        const match = /^([A-Za-z0-9_-]{1,128})\.(vtt|ass)$/.exec(
          request.params.trackFile,
        );
        if (
          subtitles === undefined ||
          match?.[1] === undefined ||
          match[2] === undefined
        )
          return reply
            .code(404)
            .send({ error: "Subtitle track is missing or expired" });
        const controller = new AbortController();
        const cancel = () => controller.abort();
        request.raw.once("aborted", cancel);
        reply.raw.once("close", cancel);
        try {
          const composed = await subtitles.compose(
            request.params.cutId,
            match[1],
            match[2],
            controller.signal,
          );
          if (composed === undefined)
            return reply
              .code(404)
              .send({ error: "Subtitle track is missing or expired" });
          return reply
            .type(composed.contentType)
            .header("cache-control", "private, max-age=300")
            .send(Buffer.from(composed.bytes));
        } catch {
          return reply.code(controller.signal.aborted ? 499 : 502).send({
            error: controller.signal.aborted
              ? "Subtitle request cancelled"
              : "Subtitle track could not be composed",
          });
        } finally {
          request.raw.off("aborted", cancel);
          reply.raw.off("close", cancel);
        }
      },
    );

    app.get<{ Params: { cutId: string } }>(
      "/api/v1/dev/cuts/:cutId/subtitles",
      async (request, reply) => {
        const diagnostic = subtitles?.diagnostics(request.params.cutId);
        return diagnostic === undefined
          ? reply.code(404).send({ error: "Cut session is missing or expired" })
          : reply.send(diagnostic);
      },
    );

    app.get<{ Params: { cutId: string } }>(
      "/api/v1/dev/cuts/:cutId/segments",
      async (request, reply) => {
        const session = sessions.get(request.params.cutId);
        if (session === undefined)
          return reply
            .code(404)
            .send({ error: "Cut session is missing or expired" });
        return reply.send({
          sourceSegments: session.outputSkipDiagnostics.length,
          outputSegments: session.outputSkipSegments.length,
          relationships: session.outputSkipDiagnostics,
        });
      },
    );
  };
}
