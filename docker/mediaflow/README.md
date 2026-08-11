# MediaFlow 2.4.9 seekable-input repair

AnimeTVCut builds `animetvcut-mediaflow:2.4.9-atc1` from the upstream MediaFlow Proxy
`v2.4.9` image pinned by digest. The corresponding upstream source revision is
`e88bf61385f9878ea27c887ae60a77ea3a25c6bc`.

The upstream HLS segment path reconstructs small synthetic input containers from media
byte ranges. MP4 chunk offsets can still address the original file, while some valid
Matroska layouts cannot provide the reconstructed `seek_header`. In both cases PyAV may
discover metadata but decode no packets from the segment source.

The patch keeps the existing MKV fast path when its reconstructed header is usable. All
other HTTP sources use the original range-capable URL as a seekable PyAV/FFmpeg input,
seek to the requested segment time, and transcode only the bounded segment interval.
Forwarded source headers are sanitized, URLs and credentials are not logged, and a stop
signal prevents a completed segment from leaving its demux thread blocked on read-ahead.

The Docker build checks hashes for every patched upstream file and aborts if they differ.
When upgrading MediaFlow, remove or rebase this patch only after the direct MP4, H.264
MKV, HEVC MKV, HTTP Range, and AnimeTVCut playback suites pass against the new version.
