export function decodeSubtitleBytes(bytes: Uint8Array): string {
  let encoding: "utf-8" | "utf-16le" | "utf-16be" = "utf-8";
  let offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    offset = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    offset = 2;
  }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(
      bytes.subarray(offset),
    );
  } catch {
    throw new Error("unsupported_encoding");
  }
}
