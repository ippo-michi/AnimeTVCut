import type { OperationMetrics } from "../services/operation-metrics.js";
import type { FastifyPluginAsync } from "fastify";

import type { CutSessionStore } from "../services/cut-session-store.js";
import {
  MediaRangeNotSatisfiableError,
  type MediaReadRange,
} from "../services/hls-source-loader.js";
import { MediaFlowError } from "../services/mediaflow/errors.js";
import { MediaPrefetcher } from "../services/media-prefetch.js";
import type { SubtitleService } from "../services/subtitle-service.js";
import type { CutWatchProgressTracker } from "../services/watch-progress.js";

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
  watchProgress?: CutWatchProgressTracker,
  metrics?: OperationMetrics,
): FastifyPluginAsync {
  if (
    !Number.isSafeInteger(prefetchResourceCount) ||
    prefetchResourceCount < 0 ||
    prefetchResourceCount > 8
  ) {
    throw new Error("Media prefetch resource count must be between 0 and 8.");
  }
  return async (app) => {
    const streamErrors = new WeakSet<object>();
    app.addHook("onResponse", async (request, reply) => {
      if (
        request.routeOptions.url === "/media/cut/:cutId/segment/:resourceId" &&
        !streamErrors.has(request)
      )
        metrics?.record(
          "playback",
          Math.round(reply.elapsedTime),
          reply.statusCode >= 500,
        );
    });
    const prefetcher = new MediaPrefetcher(prefetchResourceCount);
    app.addHook("preClose", async () => prefetcher.close());
    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/media/cut/")) return;
      reply.header("access-control-allow-origin", "*");
      reply.header("access-control-allow-methods", "GET, HEAD, OPTIONS");
      reply.header(
        "access-control-allow-headers",
        "Accept, Content-Type, Range",
      );
      reply.header(
        "access-control-expose-headers",
        "Accept-Ranges, Content-Length, Content-Range",
      );
    });
    app.options("/media/cut/*", async (_request, reply) =>
      reply.code(204).send(),
    );

    app.get<{ Params: Pick<MediaParams, "cutId"> }>(
      "/media/cut/:cutId/master.m3u8",
      async (request, reply) => {
        const session = sessions.touch(request.params.cutId);
        if (session === undefined) {
          return reply
            .code(404)
            .send({ error: "Cut session is missing or expired" });
        }
        prefetcher.prime(session);
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
          await prefetcher.wait(resource, controller.signal);
          const opened = await resource.open(range, controller.signal);
          opened.stream.once("error", () => {
            streamErrors.add(request);
            metrics?.record("playback", Math.round(reply.elapsedTime), true);
          });
          sessions.touch(request.params.cutId);
          prefetcher.after(session, resource);
          if (
            watchProgress !== undefined &&
            responseContainsWholeResource(
              opened.statusCode,
              opened.responseHeaders,
            )
          ) {
            opened.stream.once("end", () => {
              watchProgress.sourceEpisodeCompleted(session, resource);
            });
          }
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
