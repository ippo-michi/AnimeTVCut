#!/usr/bin/env python3
from pathlib import Path

ROOT = Path.cwd()


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: exact-trim target count={count}; target starts with {old.splitlines()[:3]!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


proxy = "mediaflow_proxy/routes/proxy.py"
handler = "mediaflow_proxy/remuxer/transcode_handler.py"


def patch_async_function(path: str, name: str, transform) -> None:
    import ast

    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    tree = ast.parse(text)
    matches = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == name
    ]
    if len(matches) != 1:
        raise SystemExit(
            f"{path}: expected one async function {name}, found {len(matches)}"
        )
    node = matches[0]
    lines = text.splitlines(keepends=True)
    start = node.lineno - 1
    end = node.end_lineno
    block = "".join(lines[start:end])
    replacement = transform(block)
    if replacement == block:
        raise SystemExit(f"{path}: {name} exact-trim transform made no change")
    lines[start:end] = [replacement]
    target.write_text("".join(lines), encoding="utf-8")


def insert_parameter(block: str, before: str, parameter: str) -> str:
    if "atc_exact:" in block:
        return block
    lines = block.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if before in line:
            indent = line[: len(line) - len(line.lstrip())]
            lines.insert(index, f"{indent}{parameter}\n")
            return "".join(lines)
    raise SystemExit(f"parameter insertion marker not found: {before}")


def patch_playlist(block: str) -> str:
    block = insert_parameter(
        block,
        'atc_container: str | None = Query(',
        'atc_exact: bool = Query(False, description="AnimeTVCut exact-boundary mode."),',
    )
    marker = '    base_params += f"&atc_file_size={source.file_size}"\n'
    if marker not in block:
        raise SystemExit("playlist: atc_file_size marker not found")
    if 'base_params = f"{base_params}&atc_exact=1"' not in block:
        block = block.replace(
            marker,
            marker
            + '    if atc_exact:\n'
            + '        base_params = f"{base_params}&atc_exact=1"\n',
            1,
        )
    return block


def patch_init(block: str) -> str:
    block = insert_parameter(
        block,
        'atc_file_size: int = Query(',
        'atc_exact: bool = Query(False, description="AnimeTVCut exact-boundary mode."),',
    )
    old = "    return await handle_transcode_hls_init(request, source)\n"
    new = (
        "    return await handle_transcode_hls_init(\n"
        "        request, source, force_universal=atc_exact\n"
        "    )\n"
    )
    if old not in block:
        raise SystemExit("init: handle_transcode_hls_init return marker not found")
    return block.replace(old, new, 1)


def patch_fmp4_segment(block: str) -> str:
    block = insert_parameter(
        block,
        'atc_file_size: int = Query(',
        'atc_exact: bool = Query(False, description="AnimeTVCut exact-boundary mode."),',
    )
    if "exact_trim=atc_exact" in block:
        return block
    marker = "segment_number=seg\n"
    if marker not in block:
        raise SystemExit("fMP4: segment_number call marker not found")
    return block.replace(
        marker,
        "segment_number=seg,\n            exact_trim=atc_exact,\n",
        1,
    )


def patch_ts_segment(block: str) -> str:
    block = insert_parameter(
        block,
        'atc_file_size: int = Query(',
        'atc_exact: bool = Query(False, description="AnimeTVCut exact-boundary mode."),',
    )
    if "exact_trim=atc_exact" in block:
        return block
    marker = "        segment_number=seg,\n"
    if marker not in block:
        raise SystemExit("MPEG-TS: segment_number call marker not found")
    return block.replace(
        marker,
        marker + "        exact_trim=atc_exact,\n",
        1,
    )


patch_async_function(proxy, "transcode_hls_playlist", patch_playlist)
patch_async_function(proxy, "transcode_hls_init", patch_init)
patch_async_function(proxy, "transcode_hls_segment", patch_fmp4_segment)
patch_async_function(proxy, "transcode_hls_ts_segment", patch_ts_segment)

replace_once(
    handler,
    '''def _find_segment(
    segments: list[HLSSegmentInfo],
    start_time_ms: float,
) -> HLSSegmentInfo | None:
    """Find the segment whose start_ms matches *start_time_ms* (within 1ms tolerance)."""
    for seg in segments:
        if abs(seg.start_ms - start_time_ms) < 1.0:
            return seg
    return None
''',
    '''def _find_segment(
    segments: list[HLSSegmentInfo],
    start_time_ms: float,
) -> HLSSegmentInfo | None:
    """Find the segment whose start_ms matches *start_time_ms* (within 1ms tolerance)."""
    for seg in segments:
        if abs(seg.start_ms - start_time_ms) < 1.0:
            return seg
    return None


def _find_segment_containing(
    segments: list[HLSSegmentInfo],
    start_time_ms: float,
    end_time_ms: float,
) -> HLSSegmentInfo | None:
    """Find the normalized segment containing one exact retained interval."""
    if start_time_ms < 0 or end_time_ms <= start_time_ms:
        return None
    for seg in segments:
        if (
            start_time_ms >= seg.start_ms - 1.0
            and end_time_ms <= seg.end_ms + 1.0
        ):
            return seg
    return None
''',
)
replace_once(
    handler,
    '''async def handle_transcode_hls_init(
    request: Request,
    source: MediaSource,
) -> Response:
''',
    '''async def handle_transcode_hls_init(
    request: Request,
    source: MediaSource,
    force_universal: bool = False,
) -> Response:
''',
)
replace_once(
    handler,
    "    cache_key = source.cache_key\n\n    # ---- Redis fast path: init segment already cached ----\n",
    '''    cache_key = (
        f"{source.cache_key}:atc-exact-v1"
        if force_universal
        else source.cache_key
    )

    # ---- Redis fast path: init segment already cached ----
''',
)
replace_once(
    handler,
    "    if _can_remux_hls_mkv(probe.cue_index):\n",
    "    if not force_universal and _can_remux_hls_mkv(probe.cue_index):\n",
)
replace_once(
    handler,
    '''async def handle_transcode_hls_segment(
    request: Request,
    source: MediaSource,
    start_time_ms: float,
    end_time_ms: float,
    segment_number: int | None = None,
) -> Response:
''',
    '''async def handle_transcode_hls_segment(
    request: Request,
    source: MediaSource,
    start_time_ms: float,
    end_time_ms: float,
    segment_number: int | None = None,
    exact_trim: bool = False,
) -> Response:
''',
)
replace_once(
    handler,
    '''    seg_info = _find_segment(boundaries, start_time_ms)
    if seg_info is None:
        return PlainTextResponse(
            f"start_ms={int(start_time_ms)} does not match any segment boundary",
            status_code=404,
        )

    seg_idx = seg_info.index
''',
    '''    seg_info = (
        _find_segment_containing(boundaries, start_time_ms, end_time_ms)
        if exact_trim
        else _find_segment(boundaries, start_time_ms)
    )
    if seg_info is None:
        return PlainTextResponse(
            "Requested range does not fit one normalized HLS segment",
            status_code=404,
        )

    seg_idx = seg_info.index
    requested_start_ms = start_time_ms if exact_trim else seg_info.start_ms
    requested_end_ms = end_time_ms if exact_trim else seg_info.end_ms
    if exact_trim:
        cache_key = (
            f"{cache_key}:atc-exact-v1:"
            f"{requested_start_ms:.3f}:{requested_end_ms:.3f}"
        )
''',
)
replace_once(
    handler,
    "    seg_duration_ms = seg_info.end_ms - seg_info.start_ms\n",
    "    seg_duration_ms = requested_end_ms - requested_start_ms\n",
)
replace_once(
    handler,
    '''        seg_info.start_ms / 1000.0,
        seg_info.end_ms / 1000.0,
''',
    '''        requested_start_ms / 1000.0,
        requested_end_ms / 1000.0,
''',
)
replace_once(
    handler,
    '''    use_mkv_fastpath = (
        _can_remux_hls_mkv(probe.cue_index)
    )
''',
    "    use_mkv_fastpath = (not exact_trim) and _can_remux_hls_mkv(probe.cue_index)\n",
)
replace_once(
    handler,
    '''            pyav_input = getattr(source, "pyav_open_input", lambda: None)()
            path_name = "seekable HTTP universal" if pyav_input is not None else "partial-pipe universal"
''',
    '''            pyav_input = getattr(source, "pyav_open_input", lambda: None)()
            if exact_trim and pyav_input is None:
                return PlainTextResponse(
                    "Exact trimming requires a seekable source", status_code=503
                )
            path_name = "seekable HTTP universal" if pyav_input is not None else "partial-pipe universal"
''',
)
replace_once(
    handler,
    '''                force_video_reencode=True,
                max_duration_ms=seg_duration_ms,
                start_decode_time_ms=seg_info.start_ms,
                emit_init_segment=False,
                force_software_encode=True,
                input_url=input_url,
                input_options=input_options,
                input_start_time_ms=seg_info.start_ms,
''',
    '''                force_video_reencode=True,
                max_duration_ms=seg_duration_ms,
                start_decode_time_ms=requested_start_ms,
                emit_init_segment=False,
                force_software_encode=True,
                input_url=input_url,
                input_options=input_options,
                input_start_time_ms=requested_start_ms,
''',
)
replace_once(handler, '                "end_ms": seg_info.end_ms,\n', '                "end_ms": requested_end_ms,\n')

insert_marker = '''async def handle_transcode_hls_ts_segment(
'''
exact_helper = r'''async def _mux_mpegts_exact_segment(
    input_url: str,
    input_options: dict[str, str] | None,
    start_time_ms: float,
    end_time_ms: float,
    output_start_time_ms: float,
    audio_languages: list[str],
    preferred_audio: str,
) -> bytes:
    preferred_aliases = {
        "jpn": {"jpn", "ja", "jp"},
        "eng": {"eng", "en"},
    }.get(preferred_audio, {preferred_audio})
    preferred_indices = [
        index
        for index, language in enumerate(audio_languages)
        if language.strip().lower() in preferred_aliases
    ]
    audio_order = preferred_indices + [
        index for index in range(len(audio_languages))
        if index not in preferred_indices
    ]
    audio_map_args = (
        [item for index in audio_order for item in ("-map", f"0:a:{index}")]
        if audio_order
        else ["-map", "0:a?"]
    )
    input_args = ["-ss", f"{start_time_ms / 1000.0:.6f}"]
    for option, value in (input_options or {}).items():
        input_args.extend((f"-{option}", value))
    input_args.extend(("-i", input_url))
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        *input_args,
        "-t", f"{(end_time_ms - start_time_ms) / 1000.0:.6f}",
        "-map", "0:v:0", *audio_map_args, "-sn", "-dn",
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-sc_threshold", "0",
        "-force_key_frames", "expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+2))",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k",
        "-avoid_negative_ts", "disabled", "-muxdelay", "0", "-muxpreload", "0",
        "-mpegts_flags", "resend_headers+initial_discontinuity",
        "-output_ts_offset", f"{(output_start_time_ms / 1000.0) + 1.0:.6f}",
        "-f", "mpegts", "pipe:1",
    ]
    process = await asyncio.create_subprocess_exec(
        *command,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert process.stdout is not None and process.stderr is not None
    output, stderr = await asyncio.gather(process.stdout.read(), process.stderr.read())
    return_code = await process.wait()
    if return_code != 0 or not output:
        logger.warning(
            "[hls_ts_exact] ffmpeg failed code=%s detail_bytes=%d",
            return_code,
            len(stderr),
        )
        raise RuntimeError("Exact MPEG-TS trim failed")
    return output


'''
text = (ROOT / handler).read_text(encoding="utf-8")
if text.count(insert_marker) != 1:
    raise SystemExit("transcode_handler.py: TS handler marker mismatch")
(ROOT / handler).write_text(text.replace(insert_marker, exact_helper + insert_marker, 1), encoding="utf-8")

replace_once(
    handler,
    '''    output_start_time_ms: float | None = None,
    segment_number: int | None = None,
) -> Response:
    """Serve a seekable MPEG-TS segment while copying compatible H.264 video."""
    del request, end_time_ms
''',
    '''    output_start_time_ms: float | None = None,
    segment_number: int | None = None,
    exact_trim: bool = False,
) -> Response:
    """Serve a seekable MPEG-TS segment while copying compatible H.264 video."""
    del request
''',
)
replace_once(
    handler,
    '''    seg_info = _find_segment(boundaries, start_time_ms)
    if seg_info is None:
        return PlainTextResponse("Segment boundary was not found", status_code=404)
''',
    '''    seg_info = (
        _find_segment_containing(boundaries, start_time_ms, end_time_ms)
        if exact_trim
        else _find_segment(boundaries, start_time_ms)
    )
    if seg_info is None:
        return PlainTextResponse("Segment boundary was not found", status_code=404)
    requested_start_ms = start_time_ms if exact_trim else seg_info.start_ms
    requested_end_ms = end_time_ms if exact_trim else seg_info.end_ms
    partial_exact = exact_trim and (
        abs(requested_start_ms - seg_info.start_ms) >= 1.0
        or abs(requested_end_ms - seg_info.end_ms) >= 1.0
    )
''',
)
replace_once(
    handler,
    '''    virtual_start_ms = (
        seg_info.start_ms if output_start_time_ms is None else output_start_time_ms
    )
''',
    '''    virtual_start_ms = (
        requested_start_ms if output_start_time_ms is None else output_start_time_ms
    )
''',
)
replace_once(
    handler,
    '    cache_key = f"{source.cache_key}:mpegts-v13:{language}:{virtual_start_ms:.3f}"\n',
    '''    cache_key = (
        f"{source.cache_key}:mpegts-v14:{language}:{virtual_start_ms:.3f}:"
        f"{requested_start_ms:.3f}:{requested_end_ms:.3f}"
    )
''',
)
replace_once(handler, "    copy_video = _can_remux_hls_mkv(probe.cue_index)\n", "    copy_video = _can_remux_hls_mkv(probe.cue_index) and not partial_exact\n")
replace_once(handler, "    copy_audio = bool(audio_codec_ids) and all(\n", "    copy_audio = (not partial_exact) and bool(audio_codec_ids) and all(\n")
replace_once(
    handler,
    '''    pyav_input = source.pyav_open_input()
    if probe.mp4_index is not None:
        input_url, input_options = pyav_input
        source_gen = None
    else:
''',
    '''    pyav_input = source.pyav_open_input()
    if partial_exact:
        if pyav_input is None:
            return PlainTextResponse(
                "Exact trimming requires a seekable source", status_code=503
            )
        input_url, input_options = pyav_input
        source_gen = None
    elif probe.mp4_index is not None:
        input_url, input_options = pyav_input
        source_gen = None
    else:
''',
)
replace_once(
    handler,
    '''    try:
        segment = await _mux_mpegts_segment(
            source_gen,
            seg_info.start_ms,
            seg_info.end_ms,
            virtual_start_ms,
            copy_video,
            copy_audio,
            "mp4" if probe.mp4_index is not None else "matroska",
            input_url,
            input_options,
            audio_languages,
            language,
        )
''',
    '''    try:
        if partial_exact:
            assert input_url is not None
            segment = await _mux_mpegts_exact_segment(
                input_url,
                input_options,
                requested_start_ms,
                requested_end_ms,
                virtual_start_ms,
                audio_languages,
                language,
            )
        else:
            segment = await _mux_mpegts_segment(
                source_gen,
                seg_info.start_ms,
                seg_info.end_ms,
                virtual_start_ms,
                copy_video,
                copy_audio,
                "mp4" if probe.mp4_index is not None else "matroska",
                input_url,
                input_options,
                audio_languages,
                language,
            )
''',
)
