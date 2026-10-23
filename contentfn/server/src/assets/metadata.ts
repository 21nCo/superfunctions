/**
 * Asset metadata extraction.
 * Extracts width/height for images when determinable.
 */

export interface ImageMetadata {
  width: number;
  height: number;
}

/**
 * Probe image dimensions from buffer.
 * Supports common formats: PNG, JPEG, GIF, WebP (basic detection).
 * Returns undefined if dimensions cannot be determined.
 */
export function probeImageDimensions(buffer: Buffer, contentType: string): ImageMetadata | undefined {
  try {
    if (contentType === "image/png" || isPNG(buffer)) {
      return probePNG(buffer);
    }
    if (contentType === "image/jpeg" || contentType === "image/jpg" || isJPEG(buffer)) {
      return probeJPEG(buffer);
    }
    if (contentType === "image/gif" || isGIF(buffer)) {
      return probeGIF(buffer);
    }
    if (contentType === "image/webp" || isWebP(buffer)) {
      return probeWebP(buffer);
    }
  } catch {
    // Silently fail if probing fails
  }
  return undefined;
}

function isPNG(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a;
}

function isJPEG(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

function isGIF(buffer: Buffer): boolean {
  return buffer.length >= 6 && buffer.toString("ascii", 0, 3) === "GIF" && (buffer.toString("ascii", 3, 6) === "87a" || buffer.toString("ascii", 3, 6) === "89a");
}

function isWebP(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
}

function probePNG(buffer: Buffer): ImageMetadata | undefined {
  if (buffer.length < 24) return undefined;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

function probeJPEG(buffer: Buffer): ImageMetadata | undefined {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return undefined;
    const marker = buffer[offset + 1];
    if (marker === 0xc0 || marker === 0xc2) {
      if (offset + 9 > buffer.length) return undefined;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }
    offset += 2;
    if (offset + 2 > buffer.length) return undefined;
    const segmentLength = buffer.readUInt16BE(offset);
    offset += segmentLength;
  }
  return undefined;
}

function probeGIF(buffer: Buffer): ImageMetadata | undefined {
  if (buffer.length < 10) return undefined;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return { width, height };
}

function probeWebP(buffer: Buffer): ImageMetadata | undefined {
  if (buffer.length < 30) return undefined;
  const chunkType = buffer.toString("ascii", 12, 16);
  if (chunkType === "VP8 ") {
    if (buffer.length < 30) return undefined;
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return { width, height };
  } else if (chunkType === "VP8L") {
    if (buffer.length < 25) return undefined;
    const bits = buffer.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  } else if (chunkType === "VP8X") {
    if (buffer.length < 30) return undefined;
    const width = (buffer.readUInt32LE(24) & 0xffffff) + 1;
    const height = (buffer.readUInt32LE(27) & 0xffffff) + 1;
    return { width, height };
  }
  return undefined;
}
