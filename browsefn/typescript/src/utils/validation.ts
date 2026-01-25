/**
 * Validation utilities
 */

import type { GetPageOptions, ImageSearchOptions, GeoLocation } from '../core/types.js';

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
    throw new Error(`Invalid orientation: ${options.orientation}`);
  }
  
  if (options.orderBy && !['relevant', 'latest', 'popular'].includes(options.orderBy)) {
    throw new Error(`Invalid orderBy: ${options.orderBy}`);
  }
  
  if (options.page && options.page < 1) {
    throw new Error('Page must be >= 1');
  }
  
  if (options.perPage && (options.perPage < 1 || options.perPage > 100)) {
    throw new Error('perPage must be between 1 and 100');
  }
  
  if (options.filters?.license && !['free', 'premium', 'editorial'].includes(options.filters.license)) {
    throw new Error(`Invalid license: ${options.filters.license}`);
  }
}

/**
 * Validate GeoLocation
 */
export function validateGeoLocation(location: GeoLocation): void {
  if (location.lat < -90 || location.lat > 90) {
    throw new Error('Latitude must be between -90 and 90');
  }
  
  if (location.lng < -180 || location.lng > 180) {
    throw new Error('Longitude must be between -180 and 180');
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
