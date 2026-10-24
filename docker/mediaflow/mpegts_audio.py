"""Sample-aligned AAC ownership for independently generated HLS segments."""

from dataclasses import dataclass
from math import ceil


@dataclass(frozen=True)
class MpegtsAudioPlan:
    filter: str
    packet_filter: str
    input_seek_ms: float
    start_sample: int
    end_sample: int


def mpegts_audio_plan(
    start_ms: float, end_ms: float, output_start_ms: float
) -> MpegtsAudioPlan:
    rate = 48000
    frame = 1024
    offset = round((output_start_ms - start_ms) * rate / 1000)
    # Ownership belongs to the composed output clock, including after cuts.
    first = ceil(output_start_ms * rate / 1000 / frame - 1e-8) * frame - offset
    last = (
        ceil((output_start_ms + end_ms - start_ms) * rate / 1000 / frame - 1e-8)
        * frame
        - offset
    )
    warmup = first - 48 * frame
    # Normalize the input rate before first_pts (which uses input samples).
    # Keep encoder history and lookahead, then discard their encoded packets.
    # Trimming PCM first would retain AAC priming/flush padding at every seam.
    audio_filter = (
        f"aresample={rate},aresample={rate}:first_pts={warmup},"
        f"atrim=end={(last + 2 * frame) / rate:.9f},"
        f"asetpts=N/SR/TB+{warmup}/SR/TB"
    )
    packet_filter = (
        f"noise=amount=0:drop='lt(pts\\,{first})+gte(pts\\,{last})'"
    )
    return MpegtsAudioPlan(
        filter=audio_filter,
        packet_filter=packet_filter,
        input_seek_ms=max(0.0, warmup * 1000 / rate - 250.0),
        start_sample=first,
        end_sample=last,
    )
