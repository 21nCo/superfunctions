/**
 * URL utilities for parsing, validation, and manipulation
 */

/**
 * Validate URL
 */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize URL
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove trailing slash
    parsed.pathname = parsed.pathname.replace(/\/$/, '');
    // Sort query parameters
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Get domain from URL
 */
export function getDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return '';
  }
}

/**
 * Join URL paths
 */
export function joinUrl(base: string, ...paths: string[]): string {
  try {
    const url = new URL(base);
    for (const path of paths) {
      url.pathname = url.pathname.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
    }
    return url.toString();
  } catch {
    return base;
  }
}

/**
 * Extract all URLs from text
 */
export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"]+/g;
  return text.match(urlRegex) || [];
}

/**
 * Convert relative URL to absolute
 */
export function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}
