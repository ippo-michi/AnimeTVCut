# AnimeTVCut

Phase 8 proof of concept for seekable virtual TV, Season, and Complete Series Cuts,
including timeline-mapped external text subtitles and optional output-timeline skip
controls for Stremio Enhanced and Stremio-Kai.

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
`MEDIAFLOW_REQUEST_TIMEOUT_MS` at application bootstrap. `compose.yaml` builds the
project's `2.4.9-atc2` MediaFlow image from the upstream `v2.4.9` image pinned by digest;
copy `.env.example` to `.env` and replace the example password before starting the
stack with `docker compose up -d --build`.

Upstream MediaFlow `v2.4.9` constructs partial synthetic MP4/MKV containers for HLS
segments. Those partial containers can omit required container context or retain sample
offsets into the original file, leaving PyAV with zero decodable packets. The small
version-locked patch in `docker/mediaflow/` instead lets FFmpeg/PyAV seek the original
HTTP source using Range requests, falls back from unusable MKV reconstructed headers,
and stops bounded segment demuxing promptly. Its build verifies the exact upstream
source hashes before applying the patch so an upstream change fails safely instead of
silently receiving an incompatible repair.

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

## Composed subtitles

The public stream response attaches AnimeTVCut-owned `subtitles[]` URLs for complete,
unambiguous cross-episode subtitle families. Discovery first uses standard subtitles
attached to the selected Stremio `Stream`; when `behaviorHints.videoHash` is available
and the configured manifest declares `subtitles`, it may also query that standard
resource using the exact opaque episode ID. No AIOStreams-private API is used.

SRT and WebVTT sources compose into UTF-8 WebVTT. Styled ASS and SSA sources compose
into ASS, with per-episode style namespacing and reset-style reference rewriting.
Every cue is clipped or split against the cut session's actual segment-aligned
`TimelinePiece[]`, so subtitle timing always agrees with retained video rather than
provider-requested skip coordinates.

Subtitle files are fetched only when the player requests one opaque track URL. The
result is cached for the in-memory cut lifetime, and concurrent requests coalesce.
Remote fetches have scheme, credential, DNS/SSRF, redirect, timeout, and byte limits.
Private fixture or self-hosted origins require an explicit `SUBTITLE_ALLOWED_ORIGINS`
entry; private networks are rejected by default.

Phase 6 does not extract embedded MKV subtitles, PGS/VobSub, image subtitles, or fonts
attached only inside an MKV. WebVTT STYLE/REGION blocks are omitted while cue content
and compatible cue settings are retained. SSA is normalized into the common ASS model.

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
uses real FFprobe/FFmpeg playback against AnimeTVCut. It also directly validates two
non-empty fMP4 fragments from generated H.264/AAC MP4, H.264/AAC MKV, and 10-bit
HEVC/Opus MKV inputs over an HTTP Range origin. Docker is required; no public media is
used.

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

## Stremio cut modes

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

Install AnimeTVCut's own `/manifest.json` in Stremio. Its search-only catalog exposes
three independently configurable views of each source series:

- **TV Cut** — backward-compatible approximately one-hour parts.
- **Season Cut** — one entire finalized source season.
- **Complete Cut** — all finalized normal seasons in one stream, within safety limits.

Season and Complete Cuts apply one global policy: retain the first safe opening and the
final safe ending, remove other safely identified OP/ED ranges, and remove safe recaps
and previews. When timestamps are absent, unsafe, or cannot remove a complete HLS
segment, AnimeTVCut keeps the footage rather than guessing. Complete Cuts choose one
strict source family per season, allowing legitimate release-family transitions between
seasons after MediaFlow normalizes all selected sources.

Routes:

```text
GET /catalog/series/animetvcut.json
GET /catalog/series/animetvcut/search=<query>&skip=<n>.json
GET /meta/series/<virtual-meta-id>.json
GET /stream/series/<virtual-video-id>.json
```

Catalog and meta requests are metadata-only. They do not call the stream addon,
MediaFlow, skip providers, or subtitle discovery. A stream request reloads current
source metadata, regenerates the deterministic plan, authorizes the exact finalized
scope, then sends only those opaque episode IDs into the automatic-cut flow.
MediaFlow remains a normalizer and never owns grouping, retained ranges, or cut policy.

Defaults target a one-hour part: 3000–4500 seconds, at most four episodes, assuming
90-second openings/endings and a 1440-second fallback runtime. With 24-minute episodes,
groups are 1–3, 4–6, and so on. A fresh trailing group below the minimum remains pending
for 14 days, preventing already-published groups from shifting as weekly episodes land.

`PUBLIC_BASE_URL` is mandatory for public stream playback and is the only authority
used to construct playlist URLs; request `Host` headers are ignored. Public stream
responses are cached for five minutes while the underlying in-memory cut session stays
active, and concurrent identical requests are coalesced. Cut resources use a sliding
six-hour idle lifetime with a hard 48-hour maximum; valid playlist, map, segment,
subtitle, and chapter requests refresh idle activity. Chapters derived from the actual
retained timeline are available at `GET /media/cut/<cutId>/chapters.json`.

Long cuts finalize 14 days after the newest reliable release by default. Missing release
dates do not imply completion. Defaults cap Season Cuts at 30 episodes/12 hours and
Complete Cuts at 60 episodes/24 hours, plus 20,000 retained media segments and a 5 MiB
manifest. Season zero is excluded from Complete Cuts unless explicitly enabled. These
limits and mode exposure are controlled by the `EXPOSE_*`, `LONG_CUT_*`,
`SEASON_CUT_*`, and `SERIES_CUT_*` variables in `.env.example`.

Video bytes and subtitle files remain lazy, but creating a long stream still performs
upstream family resolution, one MediaFlow playlist preparation, skip lookup, and
subtitle metadata discovery per constituent episode. Subtitle source fetches are
bounded by `SUBTITLE_COMPOSE_FETCH_CONCURRENCY` when a player selects a track.

Run the real six-episode topology with the digest-pinned MediaFlow `2.4.9-atc2` repair:

```bash
pnpm test:stremio
pnpm test:subtitles
pnpm test:long-cuts
pnpm test:aiometadata:live
pnpm test:cinemeta:live
```

It starts a generated MKV origin, a deterministic multi-catalog AIOMetadata-like addon,
a standard stream addon, and MediaFlow. The suite proves opaque-ID preservation,
metadata-only laziness, grouping, automatic skip policy, fMP4 playback, complete Part 1
decode, Part 2 probing, and seeking across both episode boundaries. No public media or
metadata service is required.

`test:long-cuts` expands that deterministic topology to two six-episode seasons whose
selected source families intentionally differ. It verifies Season and Complete Cut
planning, global OP/ED behavior across the season boundary, prepared-playlist counts,
lazy media, bounded long-subtitle fetching, chapters, fMP4 probing, ASS/libass validity,
cross-season decode, and seeking.

## Output-timeline skip controls

Every automatic cut stores immutable, provider-neutral skip intervals mapped through
the same actual `TimelinePiece[]` used by video, chapters, and subtitles. The public
endpoint is:

```text
GET /media/cut/<cutId>/segments.json
```

It returns only safely bounded retained intro, outro, recap, and preview portions in
final-output coordinates. Fully removed ranges disappear. Policy-kept ranges,
preserve-content alignment leftovers, and partially retained safe fragments are
identified explicitly. Ambiguous overlaps are omitted. Fetching this metadata touches
the active cut session but performs no MediaFlow resource request, subtitle download,
or new provider lookup. The official Stremio stream response remains standards-only;
clients derive this same-origin URL from the public HLS URL.

The optional clients share half-open interval semantics (`start <= time < end`) and
seek exactly to `end`. Manual controls are enabled and all automatic skip types are
disabled by default.

### Stremio Enhanced

Install
[`integrations/stremio-enhanced/AnimeTVCutSkip.plugin.js`](integrations/stremio-enhanced/AnimeTVCutSkip.plugin.js)
through Stremio Enhanced's plugin manager or copy it to the current Enhanced plugin
directory. Enable **AnimeTVCutSkip**, then configure its native settings if desired.
It activates only for AnimeTVCut playback and removes its overlay/state on video or
route changes, playback end, cancellation, and plugin removal.

### Stremio-Kai

The Kai integration is an isolated mpv companion rather than a fork or replacement of
Kai's native skip system. Give the installer the exact Kai directory explicitly:

```powershell
Set-Location .\integrations\stremio-kai
.\install.ps1 -KaiDirectory "C:\path\to\Stremio-Kai"
```

This works for portable or installer-extracted layouts that contain
`portable_config`. It copies only the AnimeTVCut script directory and, when absent, its
own script-options file. During AnimeTVCut playback the companion shows an OSD prompt
and temporarily binds **Tab**; leaving AnimeTVCut restores normal Kai behavior. It
does not overwrite Kai's native `notify_skip`, chapters, or global preferences.

```powershell
.\uninstall.ps1 -KaiDirectory "C:\path\to\Stremio-Kai"
```

Current Kai has no stable public injection point for its clickable web overlay or
gamepad action, so this version deliberately promises keyboard/OSD control only. Named
mpv chapters are also left untouched. See the integration-specific READMEs for exact
behavior and limitations.

Run all Phase 8 server/client checks with:

```bash
pnpm test:skip-controls
```
