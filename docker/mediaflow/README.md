# MediaFlow 2.4.9 seekable-input repair

AnimeTVCut builds `animetvcut-mediaflow:2.4.9-atc23` from the upstream MediaFlow Proxy
`v2.4.9` image pinned by digest. The corresponding upstream source revision is
`e88bf61385f9878ea27c887ae60a77ea3a25c6bc`.

The upstream HLS segment path reconstructs small synthetic input containers from media
byte ranges. MP4 chunk offsets can still address the original file, while some valid
Matroska layouts cannot provide the reconstructed `seek_header`. In both cases PyAV may
discover metadata but decode no packets from the segment source.

The default AnimeTVCut path produces seekable MPEG-TS HLS. Ordinary 8-bit H.264 video
and compatible AAC audio are packet-copied without re-encoding, while every audio track
and its language metadata are retained. Incompatible audio is normalized to 48 kHz
stereo AAC. Hi10/10-bit AVC, HEVC, AV1, and uncertain video layouts use the compatibility video-transcode path. Every independently generated
segment is muxed onto its virtual AnimeTVCut output timestamp; the cache key includes
that placement so cuts with different retained timelines cannot reuse stale timestamps.
The MPEG-TS remux maps each already keyframe-aligned Matroska slice without
output-side seeking, so reordered H.264 DTS cannot discard the boundary GOP.
Audio packet ownership is kept continuous across those seams.
Each independently generated transport stream marks its initial packets as a
standards-compliant discontinuity so continuity-counter resets are not decoded
as corrupt packets.
The fMP4 path remains available for format/regression testing.

MPEG-TS checks video compatibility independently of audio. PCM or other audio
that needs normalization cannot force compatible H.264 through a video encoder.
This preserves frame continuity and leaves segment generation enough headroom
to keep up with playback. The app warms the initial playback window as soon as
the player requests its playlist, and prefers 1080p sources over 4K when only
audio needs normalization. PCM/AAC remuxes are scored as lossless sources.
Exact-cut fragments use the same timestamp offset as copied fragments, so
switching between them cannot add or subtract a second at a skip boundary.
The AAC silence frame also clears its sample storage before encoding; encoding
uninitialized floating-point samples could hang a worker during lazy startup.
Normalized MPEG-TS audio is encoded with preroll and lookahead, then packet-trimmed
on a shared output sample grid. Encoder priming and flush padding never belong to
two adjacent segments. The regression suite checks raw packet timestamps and MPV's
decoded tone samples, including 44.1 kHz input, nonzero origins, and exact cuts.

MKV probes recover complete Info and Tracks elements with bounded range reads
when the initial 64 KiB ends inside metadata. SeekHead positions let probes skip
large attachments instead of downloading them. The cue cache is versioned so an
incomplete index from an older image is rebuilt. Files without a reconstructable
header use the seekable source for MPEG-TS generation.

AnimeTVCut preserves the media timestamps from segment URLs separately from the
zero-based HLS timeline, including for exact cuts. Rounded manifest durations
therefore cannot shift later segment requests outside their physical boundaries.

Exact cut boundaries inside a normalized segment use the bounded transcode path to
emit only the retained source interval. The `atc_exact` mode and physical source
interval participate in derived-resource cache keys.

Concurrent failures retain the URL of each failed HTTP request. A late failure from
the old CDN therefore reuses an already refreshed destination instead of invalidating
the replacement and resolving the debrid URL again.

Cross-worker resolution locks use nonblocking acquisition with cancellable waits.
Cancelling a waiting request closes its descriptor immediately, so an abandoned
executor call cannot acquire the lock later and block future playback requests.
Once the lock is held, resolution reloads shared state so a worker's older private
cache entry cannot overwrite a newer CDN destination published by another worker.

All fallback HTTP sources use the original range-capable URL as a seekable PyAV/FFmpeg
input, seek to the requested segment time, and transcode only the bounded segment
interval. Forwarded source headers are sanitized, URLs and credentials are not logged,
and a stop signal prevents a completed segment from leaving its demux thread blocked on
read-ahead. Debrid redirects are resolved once while preparing the playlist, and the
final CDN destination and file size are reused by lazy segment requests. Client
cancellation terminates the bounded FFmpeg subprocess.

The Docker build checks hashes for every patched upstream file and aborts if they differ.
When upgrading MediaFlow, remove or rebase this patch only after the direct MP4, H.264
MKV, HEVC MKV, HTTP Range, and AnimeTVCut playback suites pass against the new version.
