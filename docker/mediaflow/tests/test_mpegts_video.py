from types import SimpleNamespace
import unittest

from mediaflow_proxy.remuxer.transcode_handler import _can_copy_mpegts_video


class MpegtsVideoTest(unittest.TestCase):
    def index(self, **changes):
        return SimpleNamespace(**{
            "seek_header": b"header",
            "video_codec_id": "V_MPEG4/ISO/AVC",
            "video_codec_private": b"\x01\x64\x00\x28\xff\xe0\x00",
            "audio_codec_id": "A_PCM/INT/LIT",
            **changes,
        })

    def test_pcm_audio_does_not_require_h264_video_encoding(self):
        self.assertTrue(_can_copy_mpegts_video(self.index()))

    def test_preserves_video_guard_for_incompatible_sources(self):
        for changes in [
            {"seek_header": b""},
            {"video_codec_id": "V_MPEGH/ISO/HEVC"},
            {"video_codec_private": b"\x01\x6e\x00\x28\xff\xe0\x00"},
            {"video_codec_private": b""},
        ]:
            with self.subTest(changes=changes):
                self.assertFalse(_can_copy_mpegts_video(self.index(**changes)))


if __name__ == "__main__":
    unittest.main()
