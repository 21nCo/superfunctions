import type { DestinationSecurity, ImageDownloadOptions } from '../core/types.js';
import { BrowseFnError } from '../core/errors.js';
import { normalizeSecurity } from './destination-policy.js';

export const DEFAULT_PAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const DEFAULT_REDIRECTS = 5;
export function pageLimits(security?: DestinationSecurity) {
  const policy = normalizeSecurity(security);
  return { maxBytes: policy?.maxResponseBytes ?? DEFAULT_PAGE_BYTES, maxRedirects: policy?.maxRedirects ?? DEFAULT_REDIRECTS };
}
export function downloadLimits(options: ImageDownloadOptions) {
  const policy = normalizeSecurity(options.security);
  const bounded = (configured: number | undefined, legacy: number | undefined, fallback: number, minimum: number) => {
    if (legacy !== undefined && (!Number.isSafeInteger(legacy) || legacy < minimum)) throw new BrowseFnError({ code: 'INVALID_ARGUMENT', message: 'Download limits must be safe integers within their allowed range.' });
    return configured === undefined ? legacy ?? fallback : legacy === undefined ? configured : Math.min(configured, legacy);
  };
  return { maxBytes: bounded(policy?.maxDownloadBytes, options.maxPayloadBytes, DEFAULT_DOWNLOAD_BYTES, 1),
    maxRedirects: bounded(policy?.maxRedirects, options.maxRedirects, DEFAULT_REDIRECTS, 0) };
}
export function assertPageSize(content: string, security?: DestinationSecurity): void {
  if (Buffer.byteLength(content, 'utf8') > pageLimits(security).maxBytes) throw new BrowseFnError({ code: 'DOWNLOAD_TOO_LARGE', message: 'Page payload exceeds the configured maximum size.' });
}
export function rejectUnsupportedPageLimits(provider: string, security?: DestinationSecurity): void {
  const policy = normalizeSecurity(security);
  if (policy?.maxResponseBytes !== undefined || policy?.maxRedirects !== undefined) throw new BrowseFnError({
    code: 'UNSUPPORTED_PROVIDER_CAPABILITY', provider, message: 'Provider cannot enforce configured page transport byte or redirect limits.' });
}
