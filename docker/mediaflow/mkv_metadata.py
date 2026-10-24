"""Read complete MKV decoder metadata without downloading attachments."""

from mediaflow_proxy.remuxer.ebml_parser import (
    INFO,
    TRACKS,
    UNKNOWN_SIZE,
    iter_elements,
    read_element_id,
    read_element_size,
)

MAX_METADATA_ELEMENT_BYTES = 2 * 1024 * 1024


async def complete_mkv_header(source, header_data, segment_data_offset, seek_positions, file_size):
    """Recover Info/Tracks outside the initial probe using bounded range reads.

    The synthetic prefix retains the original Segment data offset, which the
    cue index needs to translate its byte positions into source-file offsets.
    """
    elements = {}
    positions = dict(seek_positions)
    for element_id, data_start, size, element_start in iter_elements(
        header_data, segment_data_offset, len(header_data)
    ):
        if element_id in (INFO, TRACKS):
            positions[element_id] = element_start - segment_data_offset
            if size != UNKNOWN_SIZE and data_start + size <= len(header_data):
                elements[element_id] = header_data[element_start:data_start + size]

    if INFO in elements and TRACKS in elements:
        return header_data

    async def read_range(offset, length):
        data = bytearray()
        async for chunk in source.stream(offset=offset, limit=length):
            if len(data) + len(chunk) > length:
                raise ValueError("MKV metadata range exceeded its limit")
            data.extend(chunk)
        if len(data) != length:
            raise ValueError("MKV metadata range was truncated")
        return bytes(data)

    for element_id in (INFO, TRACKS):
        if element_id in elements:
            continue
        relative_offset = positions.get(element_id)
        if relative_offset is None:
            # Nonstandard files can still use the seekable-input fallback.
            return header_data
        offset = segment_data_offset + relative_offset
        if relative_offset < 0 or (file_size > 0 and offset + 16 > file_size):
            raise ValueError("MKV metadata offset is outside the file")
        prefix = await read_range(offset, 16)
        found_id, id_end = read_element_id(prefix, 0)
        size, data_start = read_element_size(prefix, id_end)
        length = data_start + size
        if (
            found_id != element_id
            or size == UNKNOWN_SIZE
            or length > MAX_METADATA_ELEMENT_BYTES
            or (file_size > 0 and offset + length > file_size)
        ):
            raise ValueError("MKV metadata element is invalid or too large")
        elements[element_id] = (
            prefix[:length]
            if length <= len(prefix)
            else prefix + await read_range(offset + len(prefix), length - len(prefix))
        )

    return header_data[:segment_data_offset] + elements[INFO] + elements[TRACKS]
