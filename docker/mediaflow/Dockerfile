FROM mhdzumair/mediaflow-proxy:v2.4.9@sha256:48baa7a425f5cb85733677505f417b2330784c12359de0f5c991b433bc280b87

USER root

COPY docker/mediaflow/mediaflow-v2.4.9-seekable-input.patch /tmp/animetvcut-mediaflow.patch

# Refuse to patch an unexpected upstream tree. The source hashes and image
# digest tie this repair to MediaFlow 2.4.9 / e88bf613 exactly.
RUN printf '%s  %s\n' \
      'd4038d37fe583f9190d9b2353512d6fcf71d0d797a80ff508d1ec5f099a2b383' 'mediaflow_proxy/remuxer/media_source.py' \
      '45b398fe51f4dd8089f9c6e09912a09799290febdc31bc2911f1ea984de2beb6' 'mediaflow_proxy/remuxer/pyav_demuxer.py' \
      '28ef29d33adababe40c18f31906a9c6a3c1db3cd6545fdbaf2f1ebe13b511907' 'mediaflow_proxy/remuxer/transcode_pipeline.py' \
      '14b414e3f356d2d06e979f1fb454c1bf414b5783d8b8d6807f83c9ea2fb1fbe5' 'mediaflow_proxy/remuxer/transcode_handler.py' \
      | sha256sum --check --strict - \
    && apt-get update \
    && apt-get install -y --no-install-recommends patch \
    && patch --batch --forward -p1 < /tmp/animetvcut-mediaflow.patch \
    && python -m py_compile \
      mediaflow_proxy/remuxer/media_source.py \
      mediaflow_proxy/remuxer/pyav_demuxer.py \
      mediaflow_proxy/remuxer/transcode_pipeline.py \
      mediaflow_proxy/remuxer/transcode_handler.py \
    && apt-get purge -y patch \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/animetvcut-mediaflow.patch

LABEL org.opencontainers.image.title="AnimeTVCut MediaFlow repair" \
      org.opencontainers.image.version="2.4.9-atc2" \
      org.opencontainers.image.description="Range-seekable PyAV input repair for MediaFlow HLS segments"

USER mediaflow_proxy
