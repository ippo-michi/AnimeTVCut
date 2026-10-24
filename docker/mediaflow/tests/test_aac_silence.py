from types import SimpleNamespace
import unittest
from unittest.mock import patch

from mediaflow_proxy.remuxer import audio_transcoder


class AacSilenceTest(unittest.TestCase):
    def test_silence_frame_clears_uninitialized_sample_storage(self):
        class Plane:
            buffer_size = 4096

            def __init__(self):
                self.data = b"\xff" * self.buffer_size

            def update(self, data):
                self.data = data

        frame = SimpleNamespace(planes=[Plane(), Plane()])
        encoded_frames = []

        def encode(value):
            encoded_frames.append(value)
            self.assertIs(value, frame)
            for plane in value.planes:
                self.assertEqual(plane.data, bytes(plane.buffer_size))
            return [b"silent-aac-frame"]

        class Encoder:
            frame_size = 1024

            @property
            def layout(self):
                return SimpleNamespace(name="stereo")

            @layout.setter
            def layout(self, value):
                pass

            def open(self):
                pass

            def encode(self, value):
                return encode(value)

        fake_av = SimpleNamespace(
            CodecContext=SimpleNamespace(create=lambda *_: Encoder()),
            AudioFormat=lambda name: SimpleNamespace(name=name),
            AudioFrame=lambda **_: frame,
        )
        with patch.object(audio_transcoder, "av", fake_av):
            self.assertEqual(
                audio_transcoder._generate_silence_aac_frame(), b"silent-aac-frame"
            )
        self.assertEqual(len(encoded_frames), 1)


if __name__ == "__main__":
    unittest.main()
