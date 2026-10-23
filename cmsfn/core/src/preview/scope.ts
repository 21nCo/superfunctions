/** Canonical audience from trusted host configuration; paths never broaden it. */
export function previewAudience(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}
export function previewDocumentId(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const id = value.replace(/^drafts\./, '');
  return id || null;
}
