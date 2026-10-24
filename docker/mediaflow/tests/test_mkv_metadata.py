import struct
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from mediaflow_proxy.remuxer.ebml_parser import INFO, TRACKS, parse_ebml_header
from mediaflow_proxy.remuxer.mkv_metadata import (
    MAX_METADATA_ELEMENT_BYTES,
    complete_mkv_header,
)
from mediaflow_proxy.remuxer import transcode_handler


def element(element_id, payload):
    identifier = element_id.to_bytes((element_id.bit_length() + 7) // 8, "big")
    return identifier + (len(payload) | 0x10000000).to_bytes(4, "big") + payload


class Source:
    def __init__(self, data):
        self.data = data
        self.reads = []

    async def stream(self, offset=0, limit=None):
        self.reads.append((offset, limit))
        yield self.data[offset:offset + limit]


class MkvMetadataTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Only the Segment prefix and complete Info/Tracks matter here.
        self.prefix = element(0x1A45DFA3, b"") + b"\x18\x53\x80\x67\x01" + b"\xff" * 7
        self.info = element(INFO, element(0x4489, struct.pack(">d", 18000.0)))
        self.tracks = element(TRACKS, element(0xEC, b"x" * 78000))

    async def test_recovers_tracks_larger_than_the_initial_probe(self):
        data = self.prefix + self.info + self.tracks
        offset = parse_ebml_header(data)
        source = Source(data)
        header = await complete_mkv_header(source, data[:65536], offset, {}, len(data))
        self.assertEqual(header, data)
        self.assertEqual(sum(length for _, length in source.reads), len(self.tracks))

    async def test_skips_large_attachments_before_tracks(self):
        attachment = element(0x1941A469, b"font" * 1000000)
        data = self.prefix + self.info + attachment + self.tracks
        offset = len(self.prefix)
        source = Source(data)
        header = await complete_mkv_header(
            source, data[:65536], offset,
            {TRACKS: len(self.info) + len(attachment)}, len(data),
        )
        self.assertEqual(header, self.prefix + self.info + self.tracks)
        self.assertEqual(sum(length for _, length in source.reads), len(self.tracks))

    async def test_complete_headers_need_no_additional_reads(self):
        data = self.prefix + self.info + self.tracks
        source = Source(data)
        self.assertEqual(
            await complete_mkv_header(source, data, len(self.prefix), {}, len(data)), data
        )
        self.assertEqual(source.reads, [])

    async def test_rejects_oversized_metadata_before_downloading_it(self):
        data = self.prefix + self.info + element(TRACKS, b"x" * MAX_METADATA_ELEMENT_BYTES)
        source = Source(data)
        with self.assertRaisesRegex(ValueError, "too large"):
            await complete_mkv_header(source, data[:65536], len(self.prefix), {}, len(data))
        self.assertEqual(len(source.reads), 1)
        self.assertEqual(source.reads[0][1], 16)

    async def test_rejects_truncated_ranges(self):
        data = self.prefix + self.info + self.tracks
        source = Source(data[:-100])
        with self.assertRaisesRegex(ValueError, "truncated"):
            await complete_mkv_header(source, data[:65536], len(self.prefix), {}, len(data))

    async def test_missing_seek_header_uses_the_original_seekable_source(self):
        source = SimpleNamespace(
            cache_key="missing-header",
            pyav_open_input=lambda: ("http://source.test/episode.mkv", {}),
        )
        probe = SimpleNamespace(cue_index=SimpleNamespace(seek_header=b""), mp4_index=None)
        result = (probe, [(0.0, 100), (6000.0, 200)], 12000.0, 300, 0)
        mux = AsyncMock(return_value=b"transport stream")
        with (
            patch.object(transcode_handler, "_extract_probe_data", AsyncMock(return_value=result)),
            patch.object(transcode_handler, "is_redis_configured", return_value=False),
            patch.object(transcode_handler, "_mux_mpegts_exact_segment", mux),
        ):
            response = await transcode_handler.handle_transcode_hls_ts_segment(
                None, source, 0.0, 6000.0, output_start_time_ms=0.0, exact_trim=True
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.body, b"transport stream")
        self.assertEqual(mux.await_args.args[:5], (
            "http://source.test/episode.mkv", {}, 0.0, 6000.0, 0.0,
        ))


if __name__ == "__main__":
    unittest.main()
