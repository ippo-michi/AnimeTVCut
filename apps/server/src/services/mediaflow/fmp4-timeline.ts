import { Transform, type TransformCallback } from "node:stream";

const MEDIAFLOW_TRACK_TIMESCALES = new Map([
  [1, 90_000],
  [2, 48_000],
]);

interface BoxHeader {
  size: number;
  headerSize: number;
  type: string;
}

export class Fmp4TimelineError extends Error {
  public constructor(message = "MediaFlow returned an invalid fMP4 fragment.") {
    super(message);
    this.name = "Fmp4TimelineError";
  }
}

function readBoxHeader(buffer: Buffer, offset: number, end: number): BoxHeader {
  if (end - offset < 8) throw new Fmp4TimelineError();
  const shortSize = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);
  if (shortSize === 0) return { size: end - offset, headerSize: 8, type };
  if (shortSize !== 1) {
    if (shortSize < 8 || offset + shortSize > end)
      throw new Fmp4TimelineError();
    return { size: shortSize, headerSize: 8, type };
  }
  if (end - offset < 16) throw new Fmp4TimelineError();
  const extended = buffer.readBigUInt64BE(offset + 8);
  if (extended < 16n || extended > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Fmp4TimelineError();
  const size = Number(extended);
  if (offset + size > end) throw new Fmp4TimelineError();
  return { size, headerSize: 16, type };
}

function children(
  buffer: Buffer,
  start: number,
  end: number,
): Array<{ offset: number; header: BoxHeader }> {
  const result: Array<{ offset: number; header: BoxHeader }> = [];
  let offset = start;
  while (offset < end) {
    const header = readBoxHeader(buffer, offset, end);
    result.push({ offset, header });
    offset += header.size;
  }
  if (offset !== end) throw new Fmp4TimelineError();
  return result;
}

function rewriteTraf(
  buffer: Buffer,
  start: number,
  end: number,
  offsetSeconds: number,
): void {
  const boxes = children(buffer, start, end);
  const tfhd = boxes.find(({ header }) => header.type === "tfhd");
  if (tfhd === undefined) throw new Fmp4TimelineError();
  const tfhdPayload = tfhd.offset + tfhd.header.headerSize;
  if (tfhdPayload + 8 > tfhd.offset + tfhd.header.size)
    throw new Fmp4TimelineError();
  const trackId = buffer.readUInt32BE(tfhdPayload + 4);
  const timescale = MEDIAFLOW_TRACK_TIMESCALES.get(trackId);
  if (timescale === undefined) throw new Fmp4TimelineError();

  for (const tfdt of boxes.filter(({ header }) => header.type === "tfdt")) {
    const payload = tfdt.offset + tfdt.header.headerSize;
    const endOffset = tfdt.offset + tfdt.header.size;
    if (payload + 8 > endOffset) throw new Fmp4TimelineError();
    const version = buffer[payload];
    const delta = BigInt(Math.round(offsetSeconds * timescale));
    if (version === 1) {
      if (payload + 12 > endOffset) throw new Fmp4TimelineError();
      const value = buffer.readBigUInt64BE(payload + 4) + delta;
      if (value < 0n) throw new Fmp4TimelineError();
      buffer.writeBigUInt64BE(value, payload + 4);
    } else if (version === 0) {
      const value = BigInt(buffer.readUInt32BE(payload + 4)) + delta;
      if (value < 0n || value > 0xffff_ffffn) throw new Fmp4TimelineError();
      buffer.writeUInt32BE(Number(value), payload + 4);
    } else {
      throw new Fmp4TimelineError();
    }
  }
}

/** Rebase decode timestamps without touching encoded media payload bytes. */
export function rewriteMediaFlowMoofTimeline(
  moof: Buffer,
  offsetSeconds: number,
): Buffer {
  if (!Number.isFinite(offsetSeconds)) throw new Fmp4TimelineError();
  const output = Buffer.from(moof);
  const root = readBoxHeader(output, 0, output.length);
  if (root.type !== "moof" || root.size !== output.length)
    throw new Fmp4TimelineError();
  for (const child of children(output, root.headerSize, root.size).filter(
    ({ header }) => header.type === "traf",
  )) {
    rewriteTraf(
      output,
      child.offset + child.header.headerSize,
      child.offset + child.header.size,
      offsetSeconds,
    );
  }
  return output;
}

/**
 * Buffer only each small `moof` box. `mdat` payload bytes pass through as they
 * arrive, preserving response size and the lazy MediaFlow resource lifecycle.
 */
export class MediaFlowTimelineTransform extends Transform {
  private pending = Buffer.alloc(0);
  private rawBytesRemaining = 0;

  public constructor(private readonly offsetSeconds: number) {
    super();
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      this.pending = Buffer.concat([this.pending, chunk]);
      this.drain();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  public override _flush(callback: TransformCallback): void {
    try {
      this.drain();
      if (this.pending.length !== 0 || this.rawBytesRemaining !== 0)
        throw new Fmp4TimelineError();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private drain(): void {
    while (this.pending.length > 0) {
      if (this.rawBytesRemaining > 0) {
        const length = Math.min(this.rawBytesRemaining, this.pending.length);
        this.push(this.pending.subarray(0, length));
        this.pending = this.pending.subarray(length);
        this.rawBytesRemaining -= length;
        continue;
      }
      if (this.pending.length < 8) return;
      const shortSize = this.pending.readUInt32BE(0);
      const headerSize = shortSize === 1 ? 16 : 8;
      if (this.pending.length < headerSize) return;
      const size =
        shortSize === 1
          ? Number(this.pending.readBigUInt64BE(8))
          : shortSize === 0
            ? this.pending.length
            : shortSize;
      if (!Number.isSafeInteger(size) || size < headerSize)
        throw new Fmp4TimelineError();
      const type = this.pending.toString("ascii", 4, 8);
      if (type === "moof") {
        if (this.pending.length < size) return;
        this.push(
          rewriteMediaFlowMoofTimeline(
            this.pending.subarray(0, size),
            this.offsetSeconds,
          ),
        );
        this.pending = this.pending.subarray(size);
      } else {
        this.rawBytesRemaining = size;
      }
    }
  }
}
