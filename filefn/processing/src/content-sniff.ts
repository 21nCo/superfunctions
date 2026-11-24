/**
 * Checks that a file's leading bytes match the MIME type it was uploaded
 * with. sharp/libvips and ffmpeg pick their decoder from the bytes, not from
 * the declared type, so without this a file declared as `image/png` could
 * reach any decoder they have (SVG, PDF, a playlist that opens other files).
 */

/** Largest pixel count sharp decodes from an upload (about 10,000 x 10,000). */
export const MAX_INPUT_PIXELS = 100_000_000;

/** sharp options for decoding untrusted input. */
export const SHARP_INPUT_OPTIONS = { limitInputPixels: MAX_INPUT_PIXELS } as const;

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
const isRiff = (b: Uint8Array, form: string) =>
  (startsWith(b, ascii('RIFF')) || startsWith(b, ascii('RF64'))) && startsWith(b, ascii(form), 8);
// WAVE also comes big-endian (RIFX) and as broadcast BW64; ffmpeg's wav demuxer reads all four.
const isWave = (b: Uint8Array) =>
  isRiff(b, 'WAVE') || ((startsWith(b, ascii('RIFX')) || startsWith(b, ascii('BW64'))) && startsWith(b, ascii('WAVE'), 8));
// Classic TIFF (42) and BigTIFF (43), both byte orders.
const isTiff = (b: Uint8Array) =>
  startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]) ||
  startsWith(b, [0x49, 0x49, 0x2b, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2b]);
// "BM" plus a known DIB header size at offset 14 (not just two letters).
const isBmp = (b: Uint8Array) =>
  startsWith(b, ascii('BM')) && b.length >= 18 &&
  [12, 40, 52, 56, 64, 108, 124].includes(b[14] | (b[15] << 8) | (b[16] << 16) | (b[17] << 24));
const ftypBrand = (b: Uint8Array): string | null =>
  startsWith(b, ascii('ftyp'), 4) && b.length >= 12 ? String.fromCharCode(...b.subarray(8, 12)) : null;
// HEIF/AVIF images: an ftyp box with an image brand.
const IMAGE_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis']);
const isHeifImage = (b: Uint8Array) => IMAGE_BRANDS.has(ftypBrand(b) ?? '');
// ISO BMFF / QuickTime: an ftyp box, or a classic QuickTime file that starts
// with another top-level atom.
// Top-level `uuid` boxes may come first; up to a few are skipped by their
// declared sizes to reach the first recognised box.
const QUICKTIME_ATOMS = ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'];
const MAX_LEADING_UUID_BOXES = 4;
function isIsoBmff(b: Uint8Array): boolean {
  let offset = 0;
  for (let box = 0; box <= MAX_LEADING_UUID_BOXES; box++) {
    if (offset + 8 > b.length) return false;
    const type = String.fromCharCode(...b.subarray(offset + 4, offset + 8));
    if (type === 'ftyp' || QUICKTIME_ATOMS.includes(type)) return true;
    if (type !== 'uuid') return false;
    const size = ((b[offset] << 24) >>> 0) + (b[offset + 1] << 16) + (b[offset + 2] << 8) + b[offset + 3];
    // A uuid box holds at least its 8-byte header and 16-byte user type.
    if (size < 24) return false;
    offset += size;
  }
  return false;
}
const isEbml = (b: Uint8Array) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]);
const isOgg = (b: Uint8Array) => startsWith(b, ascii('OggS'));
const isFlac = (b: Uint8Array) => startsWith(b, ascii('fLaC'));
const isId3 = (b: Uint8Array) => startsWith(b, ascii('ID3'));
// MPEG audio frame or ADTS AAC: 11 (or 12) sync bits.
const isMpegFrame = (b: Uint8Array) => b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0;
// AAC in LOAS/LATM framing: the 11-bit sync word 0x2B7.
const isLoas = (b: Uint8Array) => b.length >= 3 && b[0] === 0x56 && (b[1] & 0xe0) === 0xe0;

/**
 * Where `%PDF-` starts within the first KiB (readers accept a little leading
 * junk), or -1. Decoders must be given the bytes from that offset, so they see
 * `%PDF` first and never pick another loader from the junk.
 */
export function pdfStart(b: Uint8Array): number {
  const marker = ascii('%PDF-');
  const end = Math.min(b.length - marker.length, 1024);
  for (let offset = 0; offset <= end; offset++) {
    if (startsWith(b, marker, offset)) return offset;
  }
  return -1;
}

const isPdf = (b: Uint8Array) => pdfStart(b) >= 0;

// Checked by family, not exact type: a PNG declared as image/jpeg is common
// and harmless (both are raster images libvips decodes the same way). What is
// refused is a different kind of document behind an image, PDF or media type:
// SVG, PDF or HTML as an "image", a playlist or script as "video".
const isRasterImage = (b: Uint8Array) =>
  isPng(b) || isJpeg(b) || isGif(b) || isRiff(b, 'WEBP') || isTiff(b) || isBmp(b) || isHeifImage(b);
const isMediaContainer = (b: Uint8Array) =>
  isIsoBmff(b) || isEbml(b) || isOgg(b) || isRiff(b, 'AVI ') || isWave(b) || isFlac(b) || isId3(b) || isMpegFrame(b) || isLoas(b);

const FAMILIES: Array<[RegExp, (bytes: Uint8Array) => boolean]> = [
  [/^image\/(png|jpe?g|gif|webp|tiff|bmp|avif|heic|heif)$/, isRasterImage],
  [/^application\/pdf$/, isPdf],
  [/^(video|audio)\//, isMediaContainer],
];

/**
 * Whether the bytes belong to the family of the declared type (raster image,
 * PDF, or audio/video container). A type outside these families is not checked
 * (returns true).
 */
export function contentMatchesDeclaredType(bytes: Uint8Array, mimeType: string): boolean {
  const essence = mimeType.split(';', 1)[0].trim().toLowerCase();
  const family = FAMILIES.find(([pattern]) => pattern.test(essence));
  return family ? family[1](bytes) : true;
}

/**
 * Throws CONTENT_TYPE_MISMATCH_ERROR unless the bytes are a raster image
 * (PNG, JPEG, GIF, WebP, TIFF, BMP, HEIF/AVIF), whatever type was declared.
 * For providers that hand the bytes to sharp: unlike the declared-type check,
 * this one fails closed for an unknown or non-image type.
 */
export function assertRasterImage(bytes: Uint8Array): void {
  if (!isRasterImage(bytes)) throw new Error(CONTENT_TYPE_MISMATCH_ERROR);
}

export const CONTENT_TYPE_MISMATCH_ERROR = 'File content does not match its declared type';

/** Throws CONTENT_TYPE_MISMATCH_ERROR when the bytes don't match the declared type's family. */
export function assertContentMatchesDeclaredType(bytes: Uint8Array, mimeType: string): void {
  if (!contentMatchesDeclaredType(bytes, mimeType)) {
    throw new Error(CONTENT_TYPE_MISMATCH_ERROR);
  }
}

// The ffmpeg demuxer for each declared media type. Passing it with -f keeps
// ffmpeg from probing the bytes and choosing another demuxer (an HLS or concat
// playlist behind an ID3 tag, for example).
const FFMPEG_INPUT_FORMATS: Record<string, string> = {
  'video/mp4': 'mov',
  'video/quicktime': 'mov',
  'video/webm': 'matroska',
  'video/x-matroska': 'matroska',
  'video/ogg': 'ogg',
  'video/x-msvideo': 'avi',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/aac': 'aac',
  'audio/mp4': 'mov',
  'audio/x-m4a': 'mov',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/webm': 'matroska',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
};

/**
 * ffmpeg/ffprobe input options for an untrusted file of the declared type.
 * `audio/aac` is ADTS or LOAS framing; the bytes pick which of the two
 * demuxers, and nothing else.
 */
export function ffmpegInputArgs(mimeType: string, bytes?: Uint8Array): string[] {
  const essence = mimeType.split(';', 1)[0].trim().toLowerCase();
  const format = essence === 'audio/aac' && bytes && isLoas(bytes) ? 'loas' : FFMPEG_INPUT_FORMATS[essence];
  if (!format) throw new Error(CONTENT_TYPE_MISMATCH_ERROR);
  return ['-protocol_whitelist', 'file', '-f', format];
}
