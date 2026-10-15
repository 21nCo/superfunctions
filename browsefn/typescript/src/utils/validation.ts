/**
 * Validation utilities
 */

import { BrowseFnError } from '../core/errors.js';
import type {
  GetPageOptions,
  ImageDownloadOptions,
  ImageSearchOptions,
  GeoLocation,
} from '../core/types.js';

/**
 * Validate GetPageOptions
 */
export function validateGetPageOptions(options: GetPageOptions): void {
  if (options.format && !['html', 'markdown', 'text', 'json'].includes(options.format)) {
    throw new Error(`Invalid format: ${options.format}`);
  }
  
  if (options.waitFor && !['load', 'domcontentloaded', 'networkidle'].includes(options.waitFor)) {
    throw new Error(`Invalid waitFor: ${options.waitFor}`);
  }
  
  if (options.timeout && (options.timeout < 0 || options.timeout > 300000)) {
    throw new Error('Timeout must be between 0 and 300000ms');
  }
  
  if (options.screenshot && typeof options.screenshot === 'object') {
    if (options.screenshot.format && !['png', 'jpeg'].includes(options.screenshot.format)) {
      throw new Error(`Invalid screenshot format: ${options.screenshot.format}`);
    }
    if (options.screenshot.quality && (options.screenshot.quality < 0 || options.screenshot.quality > 100)) {
      throw new Error('Screenshot quality must be between 0 and 100');
    }
  }
}

/**
 * Validate ImageSearchOptions
 */
export function validateImageSearchOptions(options: ImageSearchOptions): void {
  if (options.orientation && !['landscape', 'portrait', 'square'].includes(options.orientation)) {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: `Invalid orientation: ${options.orientation}.`,
    });
  }
  
  if (options.orderBy && !['relevant', 'latest', 'popular'].includes(options.orderBy)) {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: `Invalid orderBy: ${options.orderBy}.`,
    });
  }
  
  if (options.page !== undefined && options.page < 1) {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: 'Page must be greater than or equal to 1.',
    });
  }
  
  if (options.perPage !== undefined && (options.perPage < 1 || options.perPage > 100)) {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: 'perPage must be between 1 and 100.',
    });
  }
  
  if (options.filters?.license && !['free', 'premium', 'editorial'].includes(options.filters.license)) {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: `Invalid license: ${options.filters.license}.`,
    });
  }
}

export function validateImageDownloadOptions(options: ImageDownloadOptions): void {
  if (!options.destination) {
    return;
  }

  if (options.format && !['jpeg', 'png', 'webp'].includes(options.format)) {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: `Invalid download format: ${options.format}.`,
    });
  }

  if (
    options.quality !== undefined &&
    (!Number.isFinite(options.quality) || options.quality < 0 || options.quality > 100)
  ) {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: 'quality must be between 0 and 100.',
    });
  }

  if (
    options.maxWidth !== undefined &&
    (!Number.isInteger(options.maxWidth) || options.maxWidth <= 0)
  ) {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: 'maxWidth must be a positive integer.',
    });
  }

  if (
    options.maxHeight !== undefined &&
    (!Number.isInteger(options.maxHeight) || options.maxHeight <= 0)
  ) {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: 'maxHeight must be a positive integer.',
    });
  }

  if (options.crop) {
    const { x, y, width, height } = options.crop;
    if (
      ![x, y, width, height].every((value) => Number.isInteger(value)) ||
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0
    ) {
      throw new BrowseFnError({
        code: 'INVALID_ARGUMENT',
        message: 'crop must contain non-negative integer coordinates and positive dimensions.',
      });
    }
  }

  if (options.watermark) {
    if (!options.watermark.text && !options.watermark.image) {
      throw new BrowseFnError({
        code: 'INVALID_ARGUMENT',
        message: 'watermark requires text or image input.',
      });
    }
    if (
      options.watermark.opacity !== undefined &&
      (!Number.isFinite(options.watermark.opacity) ||
        options.watermark.opacity < 0 ||
        options.watermark.opacity > 1)
    ) {
      throw new BrowseFnError({
        code: 'INVALID_ARGUMENT',
        message: 'watermark opacity must be between 0 and 1.',
      });
    }
  }

  if (
    options.maxRedirects !== undefined &&
    (!Number.isInteger(options.maxRedirects) || options.maxRedirects < 0)
  ) {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: 'maxRedirects must be a non-negative integer.',
    });
  }

  if (
    options.maxPayloadBytes !== undefined &&
    (!Number.isInteger(options.maxPayloadBytes) || options.maxPayloadBytes <= 0)
  ) {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: 'maxPayloadBytes must be a positive integer.',
    });
  }
}

/**
 * Validate GeoLocation
 */
export function validateGeoLocation(location: GeoLocation): void {
  if (location.lat < -90 || location.lat > 90) {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: 'Latitude must be between -90 and 90.',
    });
  }
  
  if (location.lng < -180 || location.lng > 180) {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: 'Longitude must be between -180 and 180.',
    });
  }
}

/**
 * Sanitize URL
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Only allow http and https protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Invalid protocol: ${parsed.protocol}`);
    }
    return parsed.toString();
  } catch (error) {
    throw new Error(`Invalid URL: ${url}`);
  }
}
