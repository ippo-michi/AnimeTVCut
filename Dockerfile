FROM node:22-alpine AS build
RUN apk add --no-cache bash ffmpeg && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/hls/package.json packages/hls/package.json
COPY packages/skip-providers/package.json packages/skip-providers/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm fixtures:generate && pnpm build

FROM node:22-alpine AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/hls/package.json packages/hls/package.json
COPY --from=build /app/packages/skip-providers/package.json packages/skip-providers/package.json
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/hls/dist packages/hls/dist
COPY --from=build /app/packages/skip-providers/dist packages/skip-providers/dist
COPY --from=build /app/fixtures/hls fixtures/hls
EXPOSE 3000
CMD ["node", "apps/server/dist/server.js"]
