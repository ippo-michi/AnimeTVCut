FROM mhdzumair/mediaflow-proxy:v2.4.9@sha256:48baa7a425f5cb85733677505f417b2330784c12359de0f5c991b433bc280b87

USER root

COPY docker/mediaflow/mediaflow-v2.4.9-seekable-input.patch /tmp/animetvcut-mediaflow.patch
COPY docker/mediaflow/mediaflow-v2.4.9-cmaf-fragments.patch /tmp/animetvcut-cmaf.patch
COPY docker/mediaflow/mediaflow-v2.4.9-mpegts-hls.patch /tmp/animetvcut-mpegts.patch
COPY docker/mediaflow/mediaflow-v2.4.9-resolved-source.patch /tmp/animetvcut-resolved-source.patch
COPY docker/mediaflow/mediaflow-v2.4.9-resilient-source.patch /tmp/animetvcut-resilient-source.patch
COPY docker/mediaflow/mediaflow-v2.4.9-video-cues.patch /tmp/animetvcut-video-cues.patch

# Refuse to patch an unexpected upstream tree. The source hashes and image
# digest tie this repair to MediaFlow 2.4.9 / e88bf613 exactly.
RUN printf '%s  %s\n' \
      'd4038d37fe583f9190d9b2353512d6fcf71d0d797a80ff508d1ec5f099a2b383' 'mediaflow_proxy/remuxer/media_source.py' \
      '45b398fe51f4dd8089f9c6e09912a09799290febdc31bc2911f1ea984de2beb6' 'mediaflow_proxy/remuxer/pyav_demuxer.py' \
      '470b02bd7a00a013d6d4962e22ddd338c67cd9e283334738803ee5d63291703f' 'mediaflow_proxy/remuxer/ebml_parser.py' \
      '28ef29d33adababe40c18f31906a9c6a3c1db3cd6545fdbaf2f1ebe13b511907' 'mediaflow_proxy/remuxer/transcode_pipeline.py' \
      '51d323b5fb4f91872acf622649a84784eaa160251e6b157068573afc6ab0d7d6' 'mediaflow_proxy/remuxer/audio_transcoder.py' \
      'd877452eb1f12a1a058f9c2d0bd8bead4b7aef852de860776ec395c443748335' 'mediaflow_proxy/remuxer/mp4_muxer.py' \
      '14b414e3f356d2d06e979f1fb454c1bf414b5783d8b8d6807f83c9ea2fb1fbe5' 'mediaflow_proxy/remuxer/transcode_handler.py' \
      'e1365958745cc7686ae9ec31cf89be9696f6477b1feea945c13cd7d33963add9' 'mediaflow_proxy/routes/proxy.py' \
      'e4fe825a9da52b86911fd00ef2923d1b4ec305ee47b912c331fd26f1ec2ad876' 'mediaflow_proxy/utils/redis_utils.py' \
      | sha256sum --check --strict - \
    && apt-get update \
    && apt-get install -y --no-install-recommends patch \
    && patch --batch --forward -p1 < /tmp/animetvcut-mediaflow.patch \
    && patch --batch --forward -p1 < /tmp/animetvcut-cmaf.patch \
    && patch --batch --forward -p1 < /tmp/animetvcut-mpegts.patch \
    && patch --batch --forward -p1 < /tmp/animetvcut-resolved-source.patch \
    && patch --batch --forward -p1 < /tmp/animetvcut-resilient-source.patch \
    && patch --batch --forward -p1 < /tmp/animetvcut-video-cues.patch \
    && python -m py_compile \
      mediaflow_proxy/remuxer/media_source.py \
      mediaflow_proxy/remuxer/pyav_demuxer.py \
      mediaflow_proxy/remuxer/ebml_parser.py \
      mediaflow_proxy/remuxer/transcode_pipeline.py \
      mediaflow_proxy/remuxer/audio_transcoder.py \
      mediaflow_proxy/remuxer/mp4_muxer.py \
      mediaflow_proxy/remuxer/transcode_handler.py \
      mediaflow_proxy/routes/proxy.py \
      mediaflow_proxy/utils/redis_utils.py \
    && apt-get purge -y patch \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/animetvcut-mediaflow.patch /tmp/animetvcut-cmaf.patch /tmp/animetvcut-mpegts.patch /tmp/animetvcut-resolved-source.patch /tmp/animetvcut-resilient-source.patch /tmp/animetvcut-video-cues.patch

LABEL org.opencontainers.image.title="AnimeTVCut MediaFlow repair" \
      org.opencontainers.image.version="2.4.9-atc10" \
      org.opencontainers.image.description="Seekable HLS with debrid-safe resolution and continuous audio passthrough"

USER mediaflow_proxy
