import unittest

from mediaflow_proxy.remuxer.transcode_handler import (
    HLSSegmentInfo,
    _find_segment_containing,
)


class ExactSpanTest(unittest.TestCase):
    def setUp(self):
        self.segments = [
            HLSSegmentInfo(i, i * 6000, (i + 1) * 6000, i * 100, (i + 1) * 100)
            for i in range(3)
        ]

    def test_ts_span_preserves_the_one_millisecond_head(self):
        segment = _find_segment_containing(self.segments, 5999, 12000, allow_span=True)
        self.assertEqual(segment.index, 0)

    def test_fmp4_stays_within_one_normalized_segment(self):
        self.assertIsNone(_find_segment_containing(self.segments, 5000, 12000))

    def test_exact_boundary_selects_the_following_segment(self):
        segment = _find_segment_containing(self.segments, 6000, 12000, allow_span=True)
        self.assertEqual(segment.index, 1)

    def test_rejects_ranges_outside_the_source(self):
        for start, end in [(-1, 6000), (6000, 6000), (0, 18002), (18001, 18002)]:
            with self.subTest(start=start, end=end):
                self.assertIsNone(
                    _find_segment_containing(self.segments, start, end, allow_span=True)
                )
