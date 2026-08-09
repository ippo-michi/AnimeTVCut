# AnimeTVCut

Phase 5 proof of concept for discovering series through a generic Stremio metadata
addon, grouping released episodes into stable TV Cut parts, resolving each exact
episode through the existing upstream addon, and composing seekable synthetic HLS.

## Development

Requires Node.js 22+, pnpm, FFmpeg, and FFprobe.

```bash
pnpm install
pnpm fixtures:generate
pnpm dev
```

The development server binds to `127.0.0.1:3000` by default. It exposes `GET /health`,
`GET /api/v1/dev/mediaflow/health`, and `POST /api/v1/dev/cuts`. The cut endpoint retains
backward compatibility with the built-in `fixture://` MPEG-TS and fMP4 sources. It also
accepts explicit `http_file` sources when MediaFlow is configured:

```json
{
  "sources": [
    {
      "kind": "http_file",
      "episodeId": "ep1",
      "url": "https://media-origin.example/episode1.mkv",
      "headers": { "Referer": "https://media-origin.example/" }
    }
  ],
  "remove": []
}
```

`http_file` remains a development-API compatibility alias. Internally it becomes the
broader `http_media` source type, since Stremio URLs may identify MKV, MP4, HLS, DASH,
or another HTTP media endpoint. All such sources still pass through MediaFlow.

Configure `MEDIAFLOW_URL`, `MEDIAFLOW_API_PASSWORD`, and optionally
`MEDIAFLOW_REQUEST_TIMEOUT_MS` at application bootstrap. `compose.yaml` pins MediaFlow
Proxy `v2.4.9`; copy `.env.example` to `.env` and replace the example password before
starting the stack with `docker compose up -d --build`.

Configure a generic upstream Stremio addon with the complete secret manifest URL:

```text
UPSTREAM_STREMIO_MANIFEST_URL=https://addon.example/authenticated/path/manifest.json
UPSTREAM_STREMIO_REQUEST_TIMEOUT_MS=30000
```

AnimeTVCut derives standard `stream/{type}/{videoId}.json` resources relative to the
directory containing `manifest.json`; it never constructs AIOStreams credentials or
uses private AIOStreams APIs. The manifest URL, selected media URLs, and proxy-header
values are treated as secrets and omitted from diagnostics.

AnimeTVCut owns the retained timeline and cut-alignment policy. MediaFlow proxies,
normalizes, and transcodes the source into compatible HLS, but it does not receive a
`skip=` plan and does not decide which normalized segments are retained in the virtual
cut. Maps and segments remain lazy and stream through opaque AnimeTVCut URLs on demand.

## Automatic skip providers

TheIntroDB and AniSkip are configured at application bootstrap:

```text
INTRODB_ENABLED=true
INTRODB_BASE_URL=https://api.theintrodb.org/v3
INTRODB_REQUEST_TIMEOUT_MS=10000
INTRODB_MIN_CONFIDENCE=

ANISKIP_ENABLED=true
ANISKIP_BASE_URL=https://api.aniskip.com/v2
ANISKIP_REQUEST_TIMEOUT_MS=10000
```

TheIntroDB derives its IMDb identity conservatively from Stremio IDs such as
`tt1234567:1:3`. AniSkip runs only when an episode includes an explicit MAL identity;
AnimeTVCut does not perform IMDb-to-MAL mapping.

`POST /api/v1/dev/skip/resolve` returns provider-neutral diagnostics without creating a
cut. `POST /api/v1/dev/cuts/from-upstream/auto` loads each normalized playlist once,
uses its exact duration for timestamp lookup, applies the first-opening/last-ending
policy, and passes safe bounded ranges through the existing `preserve_content` HLS
alignment. The original manual endpoints remain independent from skip providers.

Open-ended credits/previews, mixed OP/ED reports, invalid/out-of-duration ranges,
duration mismatches, and reports below a configured confidence threshold are diagnostic
only. Missing or failed providers leave footage intact rather than failing playback or
guessing story boundaries.

```bash
pnpm lint
pnpm test
pnpm build
pnpm test:integration
pnpm test:mediaflow
pnpm test:upstream
pnpm test:skip
pnpm test:aiostreams:live
pnpm test:introdb:live
pnpm test:aniskip:live
```

`test:mediaflow` starts an isolated fixture-origin → MediaFlow container topology and
uses real FFprobe/FFmpeg playback against AnimeTVCut. Docker is required; no public media
is used.

`test:upstream` adds an authenticated-path fixture Stremio addon and proves the full
Stremio → family selection → MediaFlow → AnimeTVCut → FFmpeg flow. The optional live
AIOStreams smoke test is skipped unless `AIOSTREAMS_TEST_MANIFEST_URL`,
`AIOSTREAMS_TEST_TYPE`, and three `AIOSTREAMS_TEST_VIDEO_ID_*` values are supplied.

`test:skip` proves the full automatic fixture Stremio → MediaFlow → skip policy →
AnimeTVCut → FFmpeg flow without manual `remove[]`. Live provider smoke tests are
opt-in through the `INTRODB_TEST_*` and `ANISKIP_TEST_*` variables documented in
`.env.example`; normal tests never depend on public timestamp services.

Created cuts retain the initially selected URLs. Phase 3 deliberately does not refresh
or hot-replace expired playback URLs; later work can re-query using the stable family,
filename, and upstream video ID metadata.

## TV Cut Stremio addon

Configure exactly one Stremio metadata source with its complete manifest URL. Nested
authenticated addon paths and manifest query parameters are preserved internally but
never returned by health, catalog, meta, stream, or media-playlist responses.

```text
METADATA_STREMIO_MANIFEST_URL=https://metadata.example/private/path/manifest.json
METADATA_STREMIO_SEARCH_CATALOG_ID=
METADATA_STREMIO_REQUEST_TIMEOUT_MS=10000
PUBLIC_BASE_URL=https://animetvcut.example
```

The metadata addon must declare `series`, `catalog`, `meta`, and a series catalog whose
`extra` includes `search`. If no catalog ID is configured, AnimeTVCut selects the first
compatible catalog in manifest order. AIOMetadata-style addons are the primary target;
standard Cinemeta-compatible manifests use the same protocol seam.

Install AnimeTVCut's own `/manifest.json` in Stremio. Its catalog is search-only:

```text
GET /catalog/series/animetvcut.json
GET /catalog/series/animetvcut/search=<query>&skip=<n>.json
GET /meta/series/<virtual-meta-id>.json
GET /stream/series/<virtual-video-id>.json
```

Catalog and meta requests are metadata-only. They do not call the stream addon,
MediaFlow, or skip providers. A stream request reloads current source metadata,
regenerates the deterministic grouping plan, authorizes the exact finalized group,
then sends only that group's opaque episode IDs into the existing automatic-cut flow.
MediaFlow remains a normalizer and never owns grouping, retained ranges, or cut policy.

Defaults target a one-hour part: 3000–4500 seconds, at most four episodes, assuming
90-second openings/endings and a 1440-second fallback runtime. With 24-minute episodes,
groups are 1–3, 4–6, and so on. A fresh trailing group below the minimum remains pending
for 14 days, preventing already-published groups from shifting as weekly episodes land.

`PUBLIC_BASE_URL` is mandatory for public stream playback and is the only authority
used to construct playlist URLs; request `Host` headers are ignored. Public stream
responses are cached for five minutes while the underlying in-memory cut session stays
active, and concurrent identical requests are coalesced.

Run the real six-episode topology with pinned MediaFlow Proxy `v2.4.9`:

```bash
pnpm test:stremio
pnpm test:aiometadata:live
pnpm test:cinemeta:live
```

It starts a generated MKV origin, a deterministic multi-catalog AIOMetadata-like addon,
a standard stream addon, and MediaFlow. The suite proves opaque-ID preservation,
metadata-only laziness, grouping, automatic skip policy, fMP4 playback, complete Part 1
decode, Part 2 probing, and seeking across both episode boundaries. No public media or
metadata service is required.
