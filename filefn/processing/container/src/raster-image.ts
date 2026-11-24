/**
 * Whether bytes are a raster image (PNG, JPEG, GIF, WebP, TIFF, BMP,
 * HEIF/AVIF). The same signatures as `content-sniff.ts` in @filefn/processing,
 * copied because the container pins the published package. sharp picks its
 * loader from the bytes, so OCR input is refused unless it is one of these
 * (never SVG, PDF or another document sharp could load).
 */
function startsWith(bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function ascii(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0));
}

const isPng = (b: Uint8Array) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isJpeg = (b: Uint8Array) => startsWith(b, [0xff, 0xd8, 0xff]);
const isGif = (b: Uint8Array) => startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'));
const isWebp = (b: Uint8Array) =>
  (startsWith(b, ascii('RIFF')) || startsWith(b, ascii('RF64'))) && startsWith(b, ascii('WEBP'), 8);
const isTiff = (b: Uint8Array) =>
  startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]) ||
  startsWith(b, [0x49, 0x49, 0x2b, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2b]);
const isBmp = (b: Uint8Array) =>
  startsWith(b, ascii('BM')) && b.length >= 18 &&
  [12, 40, 52, 56, 64, 108, 124].includes(b[14] | (b[15] << 8) | (b[16] << 16) | (b[17] << 24));
const IMAGE_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis']);
const isHeifImage = (b: Uint8Array) =>
  startsWith(b, ascii('ftyp'), 4) && b.length >= 12 && IMAGE_BRANDS.has(String.fromCharCode(...b.subarray(8, 12)));

export function isRasterImage(b: Uint8Array): boolean {
  return isPng(b) || isJpeg(b) || isGif(b) || isWebp(b) || isTiff(b) || isBmp(b) || isHeifImage(b);
}
