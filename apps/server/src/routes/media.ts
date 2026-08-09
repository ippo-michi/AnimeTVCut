import type { FastifyPluginAsync } from "fastify";

import type { CutSessionStore } from "../services/cut-session-store.js";
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

export function mediaRoutes(
  sessions: CutSessionStore,
  subtitles?: SubtitleService,
): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: Pick<MediaParams, "cutId"> }>(
      "/media/cut/:cutId/master.m3u8",
      async (request, reply) => {
        const session = sessions.get(request.params.cutId);
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
          const opened = await resource.open(range, controller.signal);
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
  };
}
