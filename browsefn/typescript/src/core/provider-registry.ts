/**
 * Canonical provider identifiers and alias normalization helpers.
 */

import type {
  CanonicalGeoProviderId,
  CanonicalImageProviderId,
  CanonicalWebProviderId,
} from './types.js';

export const WEB_PROVIDER_IDS = [
  'cheerio',
  'firecrawl',
  'jina',
  'playwright',
  'puppeteer',
] as const satisfies readonly CanonicalWebProviderId[];

export const IMAGE_PROVIDER_IDS = [
  'pexels',
  'pixabay',
  'unsplash',
] as const satisfies readonly CanonicalImageProviderId[];

export const GEO_PROVIDER_IDS = [
  'google-maps',
  'mapbox',
  'nominatim',
] as const satisfies readonly CanonicalGeoProviderId[];

const WEB_PROVIDER_ALIASES: Readonly<Record<string, CanonicalWebProviderId>> = {
  cheerio: 'cheerio',
  firecrawl: 'firecrawl',
  jina: 'jina',
  'jina-ai': 'jina',
  playwright: 'playwright',
  puppeteer: 'puppeteer',
};

const IMAGE_PROVIDER_ALIASES: Readonly<Record<string, CanonicalImageProviderId>> = {
  pexels: 'pexels',
  pixabay: 'pixabay',
  unsplash: 'unsplash',
};

const GEO_PROVIDER_ALIASES: Readonly<Record<string, CanonicalGeoProviderId>> = {
  'google-maps': 'google-maps',
  googlemaps: 'google-maps',
  mapbox: 'mapbox',
  nominatim: 'nominatim',
};

function normalizeKey(name?: string): string | undefined {
  return name?.trim().toLowerCase();
}

export function normalizeWebProviderId(
  name?: string
): CanonicalWebProviderId | undefined {
  const key = normalizeKey(name);
  return key ? WEB_PROVIDER_ALIASES[key] : undefined;
}

export function normalizeImageProviderId(
  name?: string
): CanonicalImageProviderId | undefined {
  const key = normalizeKey(name);
  return key ? IMAGE_PROVIDER_ALIASES[key] : undefined;
}

export function normalizeGeoProviderId(
  name?: string
): CanonicalGeoProviderId | undefined {
  const key = normalizeKey(name);
  return key ? GEO_PROVIDER_ALIASES[key] : undefined;
}

export function sortProviderIds<T extends string>(ids: readonly T[]): T[] {
  return [...ids].sort();
}
