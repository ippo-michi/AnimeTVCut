import type { FastifyPluginAsync } from "fastify";

import type { CutSessionStore } from "../services/cut-session-store.js";

interface MediaParams {
  cutId: string;
  resourceId: string;
}

function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | undefined {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const start = Number.parseInt(match[1], 10);
  const end = match[2] === "" || match[2] === undefined ? size - 1 : Number.parseInt(match[2], 10);
  if (start < 0 || start >= size || end < start || end >= size) {
    return undefined;
  }
  return { start, end };
}

export function mediaRoutes(sessions: CutSessionStore): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: Pick<MediaParams, "cutId"> }>(
      "/media/cut/:cutId/master.m3u8",
      async (request, reply) => {
        const session = sessions.get(request.params.cutId);
        if (session === undefined) {
          return reply.code(404).send({ error: "Cut session is missing or expired" });
        }
        return reply.type("application/vnd.apple.mpegurl").send(session.playlist);
      },
    );

    app.get<{ Params: MediaParams }>(
      "/media/cut/:cutId/segment/:resourceId",
      async (request, reply) => {
        const session = sessions.get(request.params.cutId);
        const resource = session?.resources.get(request.params.resourceId);
        if (session === undefined || resource === undefined) {
          return reply.code(404).send({ error: "Cut resource is missing or expired" });
        }

        reply.header("Accept-Ranges", "bytes").type(resource.contentType);
        for (const [name, value] of Object.entries(resource.responseHeaders)) {
          reply.header(name, value);
        }
        const rangeHeader = request.headers.range;
        if (rangeHeader === undefined) {
          reply.header("Content-Length", resource.contentLength);
          return reply.send(resource.open());
        }
        const range = parseRange(rangeHeader, resource.contentLength);
        if (range === undefined) {
          return reply
            .code(416)
            .header("Content-Range", `bytes */${resource.contentLength}`)
            .send({ error: "Invalid byte range" });
        }
        reply
          .code(206)
          .header("Content-Length", range.end - range.start + 1)
          .header(
            "Content-Range",
            `bytes ${range.start}-${range.end}/${resource.contentLength}`,
          );
        return reply.send(resource.open(range));
      },
    );
  };
}
