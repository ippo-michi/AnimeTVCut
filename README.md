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
`fixture://episode3` MPEG-TS sources and their `fixture://fmp4-episode1` through
`fixture://fmp4-episode3` counterparts are accepted in this phase.

AnimeTVCut owns the retained timeline and cut-alignment policy. A future media normalizer
may proxy, normalize, or transcode a source into compatible HLS, but it does not decide
which normalized segments are retained in the virtual cut.

```bash
pnpm lint
pnpm test
pnpm build
pnpm test:integration
```
