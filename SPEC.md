# AnimeTVCut — Engineering Specification

## 1. Project goal

Build a self-hosted service that creates **virtual long-form cuts of anime** from ordinary episodic streams.

The user should be able to watch:

- approximately 60-minute “TV Cut” episodes made from multiple normal episodes;
- approximately 45-minute double episodes;
- an entire season as one continuous stream;
- optionally an entire series as one continuous stream.

Repeated openings, endings, recaps, and next-episode previews should be removable without permanently modifying or downloading the source files.

The output must behave like a normal seekable video stream.

Example:

```text
Original:

Episode 1:
OP → Story 1 → ED → Preview

Episode 2:
Recap → OP → Story 2 → ED → Preview

Episode 3:
OP → Story 3 → ED → Post-credit → Preview


TV Cut:

OP
Story 1
Story 2
Story 3
Post-credit
ED
```

The project must initially target:

1. Stremio
2. AIOStreams as the preferred upstream stream resolver
3. MediaFlow Proxy as an optional transport/transcoding dependency
4. later browser-extension/player integrations

Do not fork AIOStreams or MediaFlow.

---

# 2. Fundamental architecture

AnimeTVCut has four main responsibilities:

```text
Metadata
   │
   ▼
Cut Planner
   │
   ├──── Skip Segment Resolver
   │
   ▼
Source Resolver
   │
   ▼
Timeline Composer
   │
   ├──── HLS output
   ├──── subtitle output
   ├──── chapter output
   └──── skip-marker API
```

External systems:

```text
Stremio
   │
   ▼
AnimeTVCut
   │
   ├── Upstream Stremio addon
   │      └── normally AIOStreams
   │
   ├── Skip timestamp providers
   │
   └── MediaFlow Proxy
```

The AnimeTVCut backend MUST own the virtual timeline.

MediaFlow may normalize/proxy/transcode source media, but MediaFlow must not own the cut-plan data model.

---

# 3. Non-goals

Do NOT implement these in the first versions:

- DRM circumvention
- torrent downloading engine
- debrid provider implementation
- anime metadata database
- custom video codec
- permanent video rendering
- FFmpeg concatenation into giant files
- browser-site scraping in the core server
- automatic AI scene detection
- frame-perfect cutting requiring source re-encoding
- modifying AIOStreams itself
- modifying Stremio itself

AnimeTVCut is primarily a **virtual stream compositor**.

---

# 4. Technology

Use:

```text
Node.js 22+
TypeScript
Fastify
pnpm
Vitest
Zod
Pino
Redis optional
SQLite initially
Docker
```

Recommended parsing libraries may be chosen after reviewing maintenance/activity, but isolate them behind internal interfaces.

Do not couple domain logic to a particular M3U8 parser.

Main service:

```text
apps/server
```

The server should expose both:

```text
Stremio addon protocol endpoints
```

and:

```text
AnimeTVCut internal/public API endpoints
```

---

# 5. Repository structure

Use this structure:

```text
animetvcut/
├── apps/
│   └── server/
│       ├── src/
│       │   ├── app.ts
│       │   ├── server.ts
│       │   └── routes/
│       └── tests/
│
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── cut-plan/
│   │   │   ├── grouping/
│   │   │   ├── timeline/
│   │   │   ├── models/
│   │   │   └── errors/
│   │   └── tests/
│   │
│   ├── stremio/
│   │   ├── src/
│   │   │   ├── upstream-client.ts
│   │   │   ├── manifest.ts
│   │   │   ├── meta.ts
│   │   │   └── stream.ts
│   │   └── tests/
│   │
│   ├── hls/
│   │   ├── src/
│   │   │   ├── parser.ts
│   │   │   ├── composer.ts
│   │   │   ├── segment-proxy.ts
│   │   │   └── validation.ts
│   │   └── tests/
│   │
│   ├── subtitles/
│   │   ├── src/
│   │   │   ├── mapper.ts
│   │   │   ├── webvtt.ts
│   │   │   └── srt.ts
│   │   └── tests/
│   │
│   ├── skip-providers/
│   │   ├── src/
│   │   │   ├── provider.ts
│   │   │   ├── manual.ts
│   │   │   └── aniskip.ts
│   │   └── tests/
│   │
│   └── mediaflow/
│       ├── src/
│       │   └── client.ts
│       └── tests/
│
├── fixtures/
│   └── hls/
│
├── docker/
├── compose.yaml
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

Do not create every package's full implementation immediately.

Create packages incrementally as their phase begins.

---

# 6. Core domain model

Do not represent cuts merely as “remove these timestamps.”

Represent the final video as an ordered collection of retained source ranges.

```ts
type SegmentKind =
  | "content"
  | "opening"
  | "ending"
  | "recap"
  | "preview"
  | "post_credit"
  | "unknown";

interface SourceRange {
  sourceEpisodeId: string;

  sourceStart: number;
  sourceEnd: number;

  kind: SegmentKind;

  confidence?: number;
  provider?: string;
}
```

The final output consists of timeline pieces:

```ts
interface TimelinePiece {
  id: string;

  sourceEpisodeId: string;

  sourceStart: number;
  sourceEnd: number;

  outputStart: number;
  outputEnd: number;

  kind: SegmentKind;
}
```

Invariant:

```text
outputEnd - outputStart
=
sourceEnd - sourceStart
```

unless the source has explicitly been transcoded with a known timebase conversion.

Timeline pieces MUST:

- be ordered;
- never overlap in output time;
- have contiguous output time;
- have sourceStart < sourceEnd;
- retain original source episode identity.

---

# 7. Skip segment model

Use:

```ts
interface SkipSegment {
  type:
    | "opening"
    | "ending"
    | "recap"
    | "preview";

  start: number;
  end: number;

  confidence: number;

  provider: string;

  themeId?: string;
}
```

Providers implement:

```ts
interface SkipSegmentProvider {
  name: string;

  getSegments(
    request: SkipSegmentRequest
  ): Promise<SkipSegment[]>;
}
```

Provider priority should eventually be:

```text
manual override
↓
trusted remote timestamp provider
↓
embedded chapter metadata
↓
audio fingerprint detection
↓
no detected segment
```

Never invent timestamps when no provider has data.

---

# 8. Cut policies

Implement:

```ts
type CutMode =
  | "double"
  | "tv"
  | "season"
  | "series";
```

Settings:

```ts
interface CutPolicy {
  mode: CutMode;

  targetDurationSeconds: number;

  openingPolicy:
    | "first_only"
    | "none"
    | "every"
    | "each_theme_once";

  endingPolicy:
    | "last_only"
    | "none"
    | "every"
    | "each_theme_once";

  removeRecaps: boolean;
  removePreviews: boolean;
  preservePostCredits: boolean;

  targetMinSeconds: number;
  targetMaxSeconds: number;

  maxEpisodesPerCut?: number;
}
```

Default TV policy:

```json
{
  "mode": "tv",
  "targetDurationSeconds": 3600,
  "openingPolicy": "first_only",
  "endingPolicy": "last_only",
  "removeRecaps": true,
  "removePreviews": true,
  "preservePostCredits": true,
  "targetMinSeconds": 3000,
  "targetMaxSeconds": 4500,
  "maxEpisodesPerCut": 4
}
```

The target is not required to equal exactly 3600 seconds.

Never cut story content just to hit one hour.

---

# 9. Episode grouping algorithm

Do not hard-code:

```text
3 episodes = one TV Cut
```

Instead use effective runtime.

For every potential source episode:

```text
effectiveDuration =
originalDuration
- removableOpening
- removableEnding
- removableRecap
- removablePreview
```

For each starting episode:

1. consider consecutive groups of 1..maxEpisodes;
2. calculate final runtime using the actual cut policy;
3. discard candidates over `targetMaxSeconds` unless there is no alternative;
4. score remaining candidates by distance from target duration;
5. prefer a candidate at or above targetMinSeconds;
6. never reorder episodes;
7. never split an original story section merely to meet target duration.

Score example:

```ts
score =
  Math.abs(targetDuration - candidateDuration)
  + underMinimumPenalty
  + overMaximumPenalty;
```

For normal 23–25 minute anime, this will naturally tend to choose three episodes.

---

# 10. Opening/ending behavior

`first_only`:

```text
Cut composed from E1 E2 E3:

keep E1 opening
remove E2 opening
remove E3 opening
```

`last_only` ending:

```text
remove E1 ending
remove E2 ending
keep E3 ending
```

Post-credit scenes MUST NOT be considered part of an ending merely because they occur after an ending.

Example:

```text
20:40 story
21:50 ED begins
23:20 ED ends
23:21 post-credit scene
23:48 preview
```

With ending removal and preview removal:

```text
KEEP 00:00–21:50
REMOVE 21:50–23:20
KEEP 23:20–23:48
REMOVE preview range
```

This is why the internal model must use retained ranges instead of `trimStart` / `trimEnd`.

---

# 11. Virtual timeline generation

Given retained ranges:

```text
E1 00:00–22:10
E2 01:30–22:05
E3 01:30–23:40
```

produce:

```text
piece 1
source = E1
source = 00:00–22:10
output = 00:00–22:10

piece 2
source = E2
source = 01:30–22:05
output = 22:10–42:45

piece 3
source = E3
source = 01:30–23:40
output = 42:45–65:55
```

The timeline mapper must implement:

```ts
sourceToOutput(
  episodeId: string,
  sourceTime: number
): number | null
```

and:

```ts
outputToSource(
  outputTime: number
): {
  episodeId: string;
  sourceTime: number;
} | null
```

These functions should be thoroughly unit tested.

They will later be reused for:

- subtitles;
- chapters;
- skip buttons;
- player progress;
- debugging.

---

# 12. HLS compositor

The first production streaming format is HLS VOD.

The compositor receives multiple compatible HLS media playlists and outputs one synthetic media playlist.

Example conceptually:

```m3u8
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:0

# episode 1 retained segments
#EXTINF:5.8,
/segment/...

#EXTINF:5.9,
/segment/...

#EXT-X-DISCONTINUITY

# episode 2 retained segments
#EXTINF:5.8,
/segment/...

#EXT-X-DISCONTINUITY

# episode 3 retained segments
...

#EXT-X-ENDLIST
```

Follow the HLS specification for discontinuity boundaries.

`EXT-X-DISCONTINUITY` must be emitted when transitioning between separately sourced timelines and whenever required because of changes to media characteristics.

`EXT-X-TARGETDURATION` must accommodate the largest segment duration in the composed playlist.

For fMP4:

- preserve/rewrite `EXT-X-MAP`;
- emit a new initialization map when necessary;
- proxy the initialization segment.

For encrypted non-DRM HLS:

- preserve/rewrite applicable key references;
- proxy the key;
- do not expose upstream credentials in the generated playlist.

Do not implement DRM handling in AnimeTVCut.

---

# 13. Segment-boundary cutting

MVP cutting is segment-aligned.

If an opening is:

```text
61.20–151.20
```

but HLS boundaries are:

```text
60.00
66.00
72.00
...
150.00
156.00
```

the compositor should use a deterministic boundary policy.

Default:

```text
start cut:
nearest safe segment boundary

end cut:
nearest safe segment boundary
```

Store the actual applied cut independently from the requested cut.

```ts
interface AppliedCut {
  requestedStart: number;
  requestedEnd: number;

  appliedStart: number;
  appliedEnd: number;

  errorStart: number;
  errorEnd: number;
}
```

Do not pretend segment-aligned removal is frame accurate.

A later optional transcoding path may provide finer cuts.

---

# 14. Source URL proxying

Never place sensitive upstream URLs directly into the final HLS manifest.

Generated segment URLs should resemble:

```text
GET /media/:sessionId/segment/:segmentId
```

The server maps opaque IDs to:

```ts
interface ProxiedResource {
  upstreamUrl: string;
  headers: Record<string, string>;
  expiresAt?: Date;
}
```

Benefits:

- hides access tokens;
- preserves required Referer/User-Agent headers;
- allows URL refresh;
- avoids leaking debrid credentials;
- provides one origin to the player.

A session must have a TTL.

---

# 15. Source adapters

Use this abstraction:

```ts
interface MediaSource {
  id: string;

  kind:
    | "hls"
    | "dash"
    | "http-file";

  url: string;

  headers?: Record<string, string>;

  filename?: string;

  metadata?: {
    resolution?: string;
    videoCodec?: string;
    audioCodec?: string;
    audioLanguages?: string[];
    releaseGroup?: string;
  };
}
```

Never put Stremio-specific fields into the core timeline package.

---

# 16. AIOStreams / generic Stremio upstream adapter

The user configures:

```text
UPSTREAM_STREMIO_MANIFEST_URL
```

normally pointing to their configured AIOStreams manifest.

The adapter should first load the manifest and verify that it supports `stream`.

For an original episode video ID, request the corresponding standard Stremio `stream` resource.

Convert returned streams into internal `SourceCandidate` objects.

Support initially:

```text
stream.url
```

Do not attempt to compose:

```text
infoHash
nzbUrl
rarUrls
zipUrls
7zipUrls
```

unless another configured resolver has converted them into a fetchable HTTP media URL.

Return a useful unsupported-source reason rather than silently ignoring every result.

---

# 17. Source matching across episodes

A cut should preferably use the same release family across every component episode.

For every episode fetch the top N viable direct candidates.

Suggested:

```text
N = 5
```

Create a `MediaSignature`.

```ts
interface MediaSignature {
  resolution?: string;
  width?: number;
  height?: number;

  videoCodec?: string;
  videoProfile?: string;

  audioCodec?: string;
  audioChannels?: string;

  audioLanguages?: string[];

  container?: string;

  releaseGroup?: string;

  sourceHost?: string;
}
```

Score combinations across all episodes.

Example weights:

```text
same release group            +100
same video codec               +60
same resolution                +50
same audio codec               +40
same audio channel layout      +20
same source host               +15
same audio languages           +10
upstream ranking               +variable
```

Hard incompatibilities should reject a combination where direct HLS concatenation would be unsafe.

Do not rely exclusively on filename parsing.

Where possible inspect HLS metadata or probe the media.

---

# 18. MediaFlow integration

MediaFlow is optional but recommended.

Use an adapter rather than embedding MediaFlow URLs throughout the codebase.

```ts
interface MediaNormalizer {
  normalize(source: MediaSource): Promise<NormalizedMediaSource>;
}
```

Potential uses:

```text
DASH → HLS
HTTP MKV/MP4 → seekable HLS/fMP4
header-aware proxying
codec normalization
```

AnimeTVCut still creates the final synthetic timeline.

MediaFlow should not contain AnimeTVCut application state.

---

# 19. Direct-file source flow

Many AIOStreams/debrid streams may be ordinary:

```text
.mkv
.mp4
```

rather than existing HLS.

When MediaFlow is configured:

```text
AIOStreams direct URL
        ↓
MediaFlow transcode/remux HLS
        ↓
AnimeTVCut synthetic HLS compositor
        ↓
Stremio
```

Without MediaFlow:

```text
HTTP-file candidate
        ↓
unsupported for composition
```

until a native remuxer is implemented.

Avoid building a second MediaFlow inside AnimeTVCut.

---

# 20. Subtitle architecture

Do not treat subtitles as an afterthought.

The same `TimelinePiece[]` must drive subtitle mapping.

Initial formats:

```text
WebVTT
SRT
```

Later:

```text
ASS/SSA
```

For every subtitle cue:

1. determine which retained source range contains the cue;
2. discard cues entirely inside removed content;
3. clamp cues crossing a cut boundary;
4. map remaining source timestamps to output timestamps;
5. preserve text exactly;
6. output one combined subtitle file.

Example:

```text
E2 subtitle cue:
00:03:00 → 00:03:04

E2 begins at:
output 00:22:10

E2 retained source starts at:
00:01:30

Mapped subtitle:
00:23:40 → 00:23:44
```

because:

```text
22:10 + (03:00 - 01:30) = 23:40
```

Never shift subtitles using a simple whole-episode offset if an episode contains multiple retained ranges.

---

# 21. ASS subtitles

ASS support should be a separate milestone.

Requirements:

- preserve styles;
- rename colliding style names;
- preserve override tags;
- merge script info safely;
- handle fonts/attachments where practical;
- correctly remap dialogue/event timestamps.

Do not downgrade ASS into SRT automatically because anime typesetting would be lost.

---

# 22. Chapters

Expose virtual chapters:

```ts
interface VirtualChapter {
  title: string;
  start: number;

  type:
    | "opening"
    | "episode"
    | "ending"
    | "custom";

  sourceEpisodeId?: string;
}
```

Example:

```text
00:00:00 Opening
00:01:30 Episode 1
00:22:14 Episode 2
00:43:01 Episode 3
01:03:29 Ending
```

Provide:

```text
GET /api/cuts/:cutId/chapters
```

as JSON initially.

---

# 23. Skip-marker API

Since the core must not depend on Stremio-specific nonstandard skip metadata, expose:

```text
GET /api/cuts/:cutId/segments
```

Response:

```json
{
  "duration": 3884.52,
  "segments": [
    {
      "type": "opening",
      "start": 0,
      "end": 91.4
    },
    {
      "type": "ending",
      "start": 3794.1,
      "end": 3884.52
    }
  ]
}
```

This endpoint can later power:

- Stremio Enhanced plugin;
- browser extension;
- mpv script;
- custom web player;
- Nuvio-style player integration.

The endpoint should describe segments in **output timeline coordinates**, never original episode coordinates.

---

# 24. Stremio virtual metadata

AnimeTVCut should expose a distinct virtual series rather than replacing the original series.

Example:

```text
Frieren: Beyond Journey's End — TV Cut
```

Its videos might be:

```text
Part 1 — Episodes 1–3
Part 2 — Episodes 4–6
Part 3 — Episodes 7–9
...
```

Each virtual video gets a deterministic ID.

Example:

```text
atc:<sourceSeriesId>:tv:1:1-3
```

Do not depend on IMDb's colon-ID semantics for internal IDs.

Keep a mapping table.

```ts
interface VirtualEpisode {
  id: string;

  sourceSeriesId: string;

  sourceSeason: number;

  sourceEpisodes: number[];

  title: string;

  runtimeSeconds: number;

  cutMode: CutMode;
}
```

---

# 25. Stremio stream response

For a virtual episode return an HLS URL:

```json
{
  "streams": [
    {
      "name": "AnimeTVCut",
      "description": "TV Cut • Episodes 1–3 • 1080p",
      "url": "https://example/media/cut/abc/master.m3u8",
      "behaviorHints": {
        "bingeGroup": "animetvcut-tv-1080p"
      }
    }
  ]
}
```

Where practical, expose multiple source combinations:

```text
AnimeTVCut • 1080p
AnimeTVCut • 720p
```

Do not expose dozens of nearly identical combinations.

---

# 26. Cut-plan API

Provide:

```text
POST /api/cuts/plan
```

Development request example:

```json
{
  "episodes": [
    {
      "id": "ep1",
      "duration": 1440
    },
    {
      "id": "ep2",
      "duration": 1440
    },
    {
      "id": "ep3",
      "duration": 1440
    }
  ],
  "policy": {
    "mode": "tv",
    "targetDurationSeconds": 3600,
    "openingPolicy": "first_only",
    "endingPolicy": "last_only",
    "removeRecaps": true,
    "removePreviews": true,
    "preservePostCredits": true
  }
}
```

Response should include enough debug information to inspect decisions:

```json
{
  "groups": [
    {
      "episodes": ["ep1", "ep2", "ep3"],
      "duration": 3842.5,
      "pieces": [],
      "removedSegments": []
    }
  ]
}
```

---

# 27. Diagnostic endpoint

Create:

```text
GET /api/cuts/:cutId/debug
```

Return:

```text
selected source for each episode
detected media signature
all skip ranges
retained ranges
timeline pieces
requested cut points
actual segment-aligned cut points
final duration
source resolver warnings
```

This project will otherwise be extremely difficult to debug.

Never require enabling verbose logs just to understand why a cut looks wrong.

---

# 28. Caching

Cache:

```text
upstream Stremio stream result
HLS manifest
media signature
skip timestamps
generated cut plan
subtitle mapping
```

Do NOT cache entire video segments permanently by default.

Suggested initial TTLs:

```text
metadata             24 h
skip timestamps      7 d
source candidates    15 min
manifest             source-dependent
cut plan             24 h
```

Use an abstraction so Redis can replace process memory.

---

# 29. Expiring URLs

Direct/debrid URLs can expire.

Therefore a cut session must retain:

```ts
interface SourceReference {
  episodeId: string;

  upstreamVideoId: string;

  selectedCandidateFingerprint: string;

  resolvedUrl: string;

  resolvedAt: number;

  expiresAt?: number;
}
```

If a segment request fails because the source expired:

1. re-query the upstream addon;
2. find the candidate with the same stable fingerprint;
3. update its URL;
4. retry exactly once;
5. fail clearly if it cannot be restored.

Do not save temporary direct URLs as permanent database identifiers.

---

# 30. Failure strategy

Prefer a clear failure to a broken cut.

Examples:

```text
No compatible source for episode 4.

Episodes 4–6 have no common codec/resolution combination.

Opening timestamp missing for episode 7.

MediaFlow unavailable.

Source URL expired and replacement could not be found.
```

Configurable policy later:

```text
strict
best_effort
```

Default during development:

```text
strict
```

---

# 31. Security

Treat all upstream URLs as secrets.

Requirements:

- never print full upstream tokens at INFO level;
- redact query tokens from logs;
- reject arbitrary proxy URLs not tied to an active session;
- protect against SSRF;
- validate source protocols;
- optionally restrict upstream hostnames;
- give generated resource IDs short TTLs;
- do not expose MediaFlow credentials to clients;
- use constant-time comparison where API secrets are checked;
- bind development server to localhost by default.

Proxy endpoints must not become an open proxy.

---

# 32. Docker

Initial Compose services:

```yaml
services:
  animetvcut:
    build: .
    restart: unless-stopped
    environment:
      NODE_ENV: production
      DATABASE_URL: /data/animetvcut.sqlite
      UPSTREAM_STREMIO_MANIFEST_URL: ${UPSTREAM_STREMIO_MANIFEST_URL}
      MEDIAFLOW_URL: ${MEDIAFLOW_URL:-}
      MEDIAFLOW_API_PASSWORD: ${MEDIAFLOW_API_PASSWORD:-}
    volumes:
      - animetvcut_data:/data

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    profiles:
      - redis

volumes:
  animetvcut_data:
```

Do not force Redis for a single-user install.

---

# 33. Reverse proxy

The server should work correctly behind:

```text
Traefik
Caddy
nginx
```

Support:

```text
PUBLIC_BASE_URL
TRUST_PROXY
```

Never generate internal Docker hostnames in Stremio stream responses.

---

# 34. Configuration UI

Not part of the initial MVP.

Start with environment variables and JSON configuration.

Later create:

```text
/configure
```

for:

```text
upstream AIOStreams manifest
MediaFlow URL
cut mode
target runtime
opening policy
ending policy
recap setting
preview setting
preferred quality
preferred languages
```

Do not delay streaming functionality to build a settings UI.

---

# 35. Testing strategy

Three categories.

## Unit tests

Cover:

```text
range subtraction
range merging
cut policy
episode grouping
timeline source→output mapping
timeline output→source mapping
subtitle mapping
candidate scoring
URL redaction
```

## Fixture tests

Create tiny synthetic HLS fixtures.

Example:

```text
episode1/
  playlist.m3u8
  seg0.ts
  seg1.ts
  ...

episode2/
episode3/
```

Segments can use generated color bars/tone.

Tests must not require copyrighted anime.

## Integration test

Create three 30–60 second fixture episodes.

Define artificial:

```text
OP
story
ED
```

Generate a cut.

Use FFprobe/FFmpeg where useful to validate:

```text
duration
seekability
continuity
audio/video presence
```

---

# 36. Critical playback acceptance tests

Before adding AIOStreams, AniSkip, subtitles, or UI, prove:

```text
1. Three HLS VOD playlists can become one synthetic HLS VOD.

2. Playback passes E1 → E2 without stopping.

3. Playback passes E2 → E3 without stopping.

4. Seeking directly into E2 works.

5. Seeking backward from E3 into E1 works.

6. Removed segment ranges are absent.

7. Final reported duration is approximately correct.

8. Repeated requests produce deterministic playlists.

9. No upstream source URL is exposed in the generated playlist.

10. Range/session expiration produces a controlled error.
```

If these fail, stop and fix the compositor before building higher layers.

---

# 37. Development phases

## Phase 0 — repository foundation

Implement:

```text
pnpm workspace
TypeScript
Fastify server
Vitest
ESLint
Prettier
Dockerfile
health endpoint
```

No streaming logic.

Definition of done:

```text
pnpm test
pnpm lint
pnpm build
docker build .
```

all succeed.

---

## Phase 1 — local HLS compositor

Implement only:

```text
HLS VOD parsing
retained ranges
timeline builder
synthetic HLS output
segment proxy
EXT-X-DISCONTINUITY
fixture media
seek tests
```

Input sources are local fixture HLS files.

Skip timestamps are manual.

No:

```text
AIOStreams
AniSkip
MediaFlow
Stremio catalog
subtitles
browser extension
```

This is the most important milestone.

---

## Phase 2 — MediaFlow source normalization

Add:

```text
MediaFlow adapter
HTTP-file → HLS normalization
DASH → HLS normalization where applicable
media signature inspection
```

Keep local fixture tests.

---

## Phase 3 — generic upstream Stremio/AIOStreams

Add:

```text
manifest client
stream-resource client
stream.url extraction
candidate ranking
multi-episode compatible-source selection
URL refresh
```

AIOStreams must be treated as an ordinary Stremio upstream wherever possible.

---

## Phase 4 — skip providers

Add:

```text
manual provider
AniSkip provider
provider priority
timestamp cache
confidence
```

Later:

```text
needle
AniChapters-style audio matching
```

These local detectors are fallbacks, not requirements for normal playback.

---

## Phase 5 — Stremio virtual series

Add:

```text
manifest
catalog
meta
virtual episodes
stream handler
bingeGroup
```

Expose TV Cuts inside Stremio.

---

## Phase 6 — subtitle composition

Add:

```text
WebVTT
SRT
timeline remapping
cut-boundary handling
```

Then separately:

```text
ASS/SSA
```

---

## Phase 7 — season/series cuts

The core timeline code should make these relatively simple.

Add:

```text
double
TV Cut
season
series
```

Do not introduce separate streaming engines for each mode.

They differ only in grouping and cut policy.

---

## Phase 8 — skip button integrations

Use:

```text
/api/cuts/:id/segments
```

Build optional integrations for:

```text
Stremio Enhanced
mpv
browser player
other clients
```

The standard stream must remain playable without these integrations.

---

## Phase 9 — browser extension

Only after the backend is stable.

Architecture:

```ts
interface SiteAdapter {
  matches(url: URL): boolean;

  getAnimeIdentity(): Promise<AnimeIdentity>;

  getCurrentEpisode(): Promise<number>;

  getPlayableSource(): Promise<MediaSource>;

  mountAnimeTVCutControls(): Promise<void>;
}
```

Every streaming website should live in its own adapter.

Do not put website-specific selectors in shared code.

Do not implement DRM bypass.

---

# 38. Future feature: each-theme-once

Long-running anime can change openings.

For:

```text
E1–12  OP1
E13–24 OP2
```

`each_theme_once` should produce:

```text
OP1
E1
E2
...
E12

OP2
E13
...
E24

final ED
```

This requires skip providers to expose a stable `themeId`.

Do not attempt to infer theme identity solely from timestamps.

---

# 39. Future feature: transition polish

Do not implement initially.

Possible later settings:

```text
hard cut
100ms audio fade
250ms black frame
chapter transition
```

Hard cuts are the MVP.

Avoid unnecessary transcoding merely to make transitions prettier.

---

# 40. Logging

Structured logging.

Every playback session gets:

```text
requestId
cutId
sessionId
sourceSeriesId
virtualEpisodeId
```

Never log:

```text
debrid API keys
MediaFlow passwords
complete tokenized playback URLs
cookies
authorization headers
```

---

# 41. API versioning

Internal/public AnimeTVCut API:

```text
/api/v1/...
```

Media URLs:

```text
/media/...
```

Stremio:

```text
/manifest.json
/catalog/...
/meta/...
/stream/...
```

Do not version Stremio routes under `/api/v1`.

---

# 42. Definition of MVP

The MVP is complete when:

1. AnimeTVCut accepts a configured upstream Stremio/AIOStreams manifest.
2. Three sequential original anime episodes can be resolved to compatible HTTP streams.
3. Direct files can be normalized through configured MediaFlow when necessary.
4. Manual or AniSkip timestamps identify OP/ED.
5. Middle OP/ED ranges are removed.
6. First OP and final ED remain.
7. The result is exposed as a seekable HLS VOD.
8. Stremio can play the resulting virtual episode.
9. Seeking across original episode boundaries works.
10. SRT/WebVTT subtitles remain synchronized.
11. Post-credit scenes are preserved when correctly identified.
12. A `/segments` endpoint exposes final opening/ending coordinates.
13. No giant intermediate output file is created.
14. Restarting the service does not destroy saved configuration.
15. Errors identify the episode/source that caused the cut to fail.

---

# 43. Rules for Codex

These rules are important.

1. Work on one development phase at a time.

2. Before making changes:
   - inspect the repository;
   - describe the relevant existing architecture;
   - identify files that will change.

3. Do not implement future phases unless explicitly requested.

4. Do not rewrite working architecture merely because another architecture seems cleaner.

5. Add tests with every core-domain feature.

6. Run:
   ```text
   pnpm lint
   pnpm test
   pnpm build
   ```
   before claiming completion.

7. If a playback assumption is uncertain:
   - create a minimal reproducible fixture;
   - test it;
   - do not guess.

8. Never silently fall back to transcoding.

9. Never silently remove story content.

10. Never fabricate skip timestamps.

11. Never silently select incompatible releases from different episodes.

12. Keep source-resolution logic separate from timeline logic.

13. Keep Stremio-specific types out of `packages/core`.

14. Preserve debuggability over abstraction cleverness.

15. Prefer a small working phase over partial implementations of five phases.

16. At completion, report:
   - changed files;
   - implementation summary;
   - tests added;
   - commands run;
   - unresolved problems;
   - the next recommended phase.

---

# 44. First architectural principle

The most important invariant in the entire project is:

> AnimeTVCut does not create a new video. It creates a new timeline over existing video sources.

Everything — HLS, subtitles, chapters, skip buttons, episode grouping, progress mapping — should derive from that timeline.

Do not create separate timestamp logic for each subsystem.