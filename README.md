# AnimeTVCut

Phase 0/1 proof of concept for composing retained ranges from local HLS VOD fixtures into
one seekable synthetic HLS VOD.

## Development

Requires Node.js 22+, pnpm, FFmpeg, and FFprobe.

```bash
pnpm install
pnpm fixtures:generate
pnpm dev
```

The development server binds to `127.0.0.1:3000` by default. It exposes `GET /health` and
`POST /api/v1/dev/cuts`. Only the built-in `fixture://episode1`, `fixture://episode2`, and
`fixture://episode3` sources are accepted in this phase.

```bash
pnpm lint
pnpm test
pnpm build
pnpm test:integration
```
