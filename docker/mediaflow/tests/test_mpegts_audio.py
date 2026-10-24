import unittest

from mediaflow_proxy.remuxer.mpegts_audio import mpegts_audio_plan


class MpegtsAudioTest(unittest.TestCase):
    def test_adjacent_fragments_own_disjoint_whole_aac_frames(self):
        boundaries = [46, 5343, 10849, 17134, 21531]
        plans = [
            mpegts_audio_plan(start, end, start - boundaries[0])
            for start, end in zip(boundaries, boundaries[1:])
        ]
        for left, right in zip(plans, plans[1:]):
            self.assertEqual(left.end_sample, right.start_sample)
        for plan in plans:
            self.assertEqual((plan.end_sample - plan.start_sample) % 1024, 0)
            self.assertIn("noise=amount=0:drop=", plan.packet_filter)
            self.assertIn("aresample=48000,aresample=48000:first_pts=", plan.filter)

    def test_grid_follows_output_clock_when_a_cut_changes_source_offset(self):
        before = mpegts_audio_plan(160790, 166041, 160744)
        after = mpegts_audio_plan(256012, 261243, 165995)
        before_output_end = before.end_sample + round((160744 - 160790) * 48)
        after_output_start = after.start_sample + round((165995 - 256012) * 48)
        self.assertEqual(before_output_end, after_output_start)
        self.assertGreater(after.input_seek_ms, 0)
        self.assertLess(after.input_seek_ms, 256012 - 1000)


if __name__ == "__main__":
    unittest.main()
