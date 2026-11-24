/**
 * Response headers for bytes FileFn serves itself (proxy downloads of files,
 * share links and artifacts). The stored content type is whatever the uploader
 * declared, so only types a browser cannot run script from are served inline;
 * everything else is a download, with `nosniff` and a sandboxing CSP on every
 * response.
 */

/**
 * Content types served inline. None of them can run script in the page's
 * origin: raster images, PDF (rendered by the browser's own viewer), plain
 * text, and common audio and video.
 */
export const INLINE_SAFE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'application/pdf',
  'text/plain',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
]);

/** The MIME type without parameters, lower-cased: `Text/HTML; charset=x` -> `text/html`. */
export function contentTypeEssence(contentType: string | null | undefined): string {
  return (contentType ?? '').split(';', 1)[0].trim().toLowerCase();
}

export function isInlineSafeContentType(contentType: string | null | undefined): boolean {
  return INLINE_SAFE_CONTENT_TYPES.has(contentTypeEssence(contentType));
}

// The PDF viewers in Chromium and Firefox refuse to render a document whose
// CSP includes `sandbox`, so PDF gets a CSP without it; the viewer runs the
// document outside the page's origin either way.
const SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
const PDF_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'";

function asciiFallbackFileName(fileName: string): string {
  // Quoted-string form for old clients: printable ASCII only, no quotes or backslashes.
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim();
  return ascii.length > 0 ? ascii : 'download';
}

/** `Content-Disposition` value: RFC 6266 with an RFC 5987 `filename*` for non-ASCII names. */
export function contentDisposition(type: 'inline' | 'attachment', fileName?: string | null): string {
  if (!fileName) {
    return type;
  }
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${asciiFallbackFileName(fileName)}"; filename*=UTF-8''${encoded}`;
}

export interface DownloadHeadersInput {
  contentType: string;
  size: number;
  fileName?: string | null;
}

/** Headers for a proxied download: safe types inline, all others as an attachment. */
export function buildDownloadHeaders(input: DownloadHeadersInput): Record<string, string> {
  const inline = isInlineSafeContentType(input.contentType);
  const essence = contentTypeEssence(input.contentType);
  return {
    // An unsafe type is still labelled as declared; the attachment
    // disposition, nosniff and the sandbox keep a browser from rendering it.
    'Content-Type': input.contentType || 'application/octet-stream',
    'Content-Length': input.size.toString(),
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', input.fileName),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': essence === 'application/pdf' ? PDF_CSP : SANDBOX_CSP,
  };
}

/**
 * Extra `signDownloadUrl` input for a stored object: an unsafe type is signed
 * with a `application/octet-stream` response type, so a storage domain related
 * to the app never renders an uploader's HTML or SVG.
 */
export function signedDownloadConstraints(
  contentType: string | null | undefined,
): { constraints?: { responseContentType: string } } {
  return isInlineSafeContentType(contentType) ? {} : { constraints: { responseContentType: 'application/octet-stream' } };
}
