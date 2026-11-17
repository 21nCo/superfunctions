import type { Policy } from '../policies.js';

/** Who produced an artifact: a processor on the server, or the client on the device. */
export type ArtifactSource = 'client' | 'server';

/** Largest client-supplied thumbnail, in bytes. */
export const CLIENT_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/** Thumbnail kinds a client may supply: the kinds the render resolver reads. */
export const CLIENT_THUMBNAIL_KINDS = ['thumbnail-small', 'thumbnail-medium', 'thumbnail-large'] as const;

/** Kind of a client-supplied converted image (for example a HEIC photo as PNG). */
export const CLIENT_CONVERTED_KIND = 'converted';

/** Every kind a client may supply. Any other kind is refused. */
export const CLIENT_ARTIFACT_KINDS: readonly string[] = [...CLIENT_THUMBNAIL_KINDS, CLIENT_CONVERTED_KIND];

const THUMBNAIL_MIME_TYPES = ['image/webp', 'image/png', 'image/jpeg'];
const CONVERTED_MIME_TYPES = ['image/png'];

/** Largest processing duration a client may report: one day, in milliseconds. */
export const MAX_CLIENT_PROCESSING_DURATION_MS = 86_400_000;

export interface ClientArtifactRule {
  mimeTypes: string[];
  maxSizeBytes: number;
}

/**
 * The content types and size limit for one client-supplied kind under a
 * file's policy, or `undefined` when clients may not supply that kind. A
 * converted image may be as large as the policy lets the file be; without a
 * policy cap, `defaultMaxBytes` (the processing source limit) applies.
 */
export function clientArtifactRule(
  kind: string,
  policy: Pick<Policy, 'maxSizeBytes'> | undefined,
  defaultMaxBytes: number,
): ClientArtifactRule | undefined {
  if ((CLIENT_THUMBNAIL_KINDS as readonly string[]).includes(kind)) {
    return { mimeTypes: THUMBNAIL_MIME_TYPES, maxSizeBytes: CLIENT_THUMBNAIL_MAX_BYTES };
  }
  if (kind === CLIENT_CONVERTED_KIND) {
    return { mimeTypes: CONVERTED_MIME_TYPES, maxSizeBytes: policy?.maxSizeBytes ?? defaultMaxBytes };
  }
  return undefined;
}

/** The media type of a Content-Type header value, without parameters, lowercased. */
export function normalizeMimeType(contentType: string | null | undefined): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

/** FileFn's record of a client-supplied artifact, stored under `metadata.processing`. */
export interface ClientArtifactProcessingMetadata {
  source: 'client';
  /** Processing time the client reported, in milliseconds. */
  durationMs?: number;
  /** Storage target the artifact object was written to. */
  storageTarget: string;
}

/** Where an artifact row came from; rows written before sources were recorded are server rows. */
export function artifactSourceOf(row: { metadata?: Record<string, unknown> }): ArtifactSource {
  const processing = row.metadata?.processing as { source?: unknown } | undefined;
  return processing?.source === 'client' ? 'client' : 'server';
}

/** The processing duration an artifact row recorded, if any. */
export function artifactDurationOf(row: { metadata?: Record<string, unknown> }): number | undefined {
  const durationMs = (row.metadata?.processing as { durationMs?: unknown } | undefined)?.durationMs;
  return typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : undefined;
}
