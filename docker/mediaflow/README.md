# MediaFlow 2.4.9 seekable-input repair

AnimeTVCut builds `animetvcut-mediaflow:2.4.9-atc10` from the upstream MediaFlow Proxy
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
The fMP4 path remains available for format/regression testing.

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
