/**
 * Nominatim (OpenStreetMap) provider for geocoding.
 */

import { BrowseFnError } from '../../core/errors.js';
import type {
  GeoAddress,
  GeocodeOptions,
  GeoLocation,
  GeoPlace,
  GeoProvider,
  GeoSearchOptions,
  ReverseGeocodeResult,
} from '../../core/types.js';

interface NominatimSearchResult {
  place_id?: string | number;
  display_name?: string;
  lat: string;
  lon: string;
  type?: string;
  class?: string;
  importance?: number;
  address?: Record<string, string>;
}

/** Spherical-cap rectangles split at the antimeridian. */
export function radiusViewboxes(lat: number, lng: number, radius: number): number[][] {
  if (![lat, lng, radius].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || radius < 0) throw new RangeError('Invalid center or radius');
  const angle = Math.min(radius / 6371000, Math.PI), latitude = lat * Math.PI / 180, degrees = 180 / Math.PI;
  const south = Math.max(-90, (latitude-angle)*degrees), north = Math.min(90, (latitude+angle)*degrees);
  if (south <= -90 || north >= 90) return [[-180, south, 180, north]];
  const offset = Math.asin(Math.min(1, Math.sin(angle)/Math.cos(latitude)))*degrees;
  const west = lng-offset, east = lng+offset;
  if (west < -180) return [[west+360, south, 180, north], [-180, south, east, north]];
  if (east > 180) return [[west, south, 180, north], [-180, south, east-360, north]];
  return [[west, south, east, north]];
}

export class NominatimProvider implements GeoProvider {
  name = 'nominatim';

  constructor(
    private config: {
      endpoint?: string;
      userAgent: string;
    }
  ) {}

  async reverseGeocode(location: GeoLocation): Promise<ReverseGeocodeResult> {
    const endpoint = this.config.endpoint || 'https://nominatim.openstreetmap.org';
    const params = new URLSearchParams({
      lat: location.lat.toString(),
      lon: location.lng.toString(),
      format: 'json',
      addressdetails: '1',
    });

    const response = await fetch(`${endpoint}/reverse?${params}`, {
      headers: { 'User-Agent': this.config.userAgent },
    });

    if (!response.ok) {
      throw new Error(`Nominatim API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as NominatimSearchResult;
    return {
      location,
      address: this.toAddress(data.address, data.display_name),
      placeId: data.place_id?.toString(),
      provider: this.name,
    };
  }

  async geocode(
    address: string,
    options: GeocodeOptions = {}
  ): Promise<ReverseGeocodeResult[]> {
    const bounds = options.bounds;
    const boxes = bounds
      ? bounds.sw.lng > bounds.ne.lng
        ? [[bounds.sw.lng, bounds.sw.lat, 180, bounds.ne.lat], [-180, bounds.sw.lat, bounds.ne.lng, bounds.ne.lat]]
        : [[bounds.sw.lng, bounds.sw.lat, bounds.ne.lng, bounds.ne.lat]]
      : [undefined];
    const results: NominatimSearchResult[] = [];
    const seen = new Set<string>();
    for (const box of boxes) {
      for (const result of await this.fetchSearch(address, options.limit, box, options.components)) {
        const identity = JSON.stringify([result.place_id, result.lat, result.lon]);
        if (!seen.has(identity)) { seen.add(identity); results.push(result); }
      }
    }
    results.splice(options.limit ?? 5);
    return results.map((result) => ({
      location: {
        lat: parseFloat(result.lat),
        lng: parseFloat(result.lon),
      },
      address: this.toAddress(result.address, result.display_name),
      placeId: result.place_id?.toString(),
      provider: this.name,
    }));
  }

  async search(options: GeoSearchOptions): Promise<GeoPlace[]> {
    const boxes = options.center && options.radius !== undefined
      ? radiusViewboxes(options.center.lat, options.center.lng, options.radius) : [undefined];
    const results: NominatimSearchResult[] = [];
    const seen = new Set<string>();
    for (const box of boxes) {
      for (const result of await this.fetchSearch(options.query, options.limit ?? 20, box)) {
        const identity = JSON.stringify([result.place_id, result.lat, result.lon]);
        if (!seen.has(identity)) { seen.add(identity); results.push(result); }
      }
    }
    results.splice(options.limit ?? 20);
    return results.map((result) => ({
      id: result.place_id?.toString() || '',
      name:
        result.display_name?.split(',')[0]?.trim() ||
        result.address?.amenity ||
        result.address?.road ||
        result.address?.city ||
        options.query,
      location: {
        lat: parseFloat(result.lat),
        lng: parseFloat(result.lon),
      },
      address: this.toAddress(result.address, result.display_name),
      types: [result.class, result.type].filter(
        (value): value is string => Boolean(value)
      ),
      provider: this.name,
    }));
  }

  async getPlaceDetails(): Promise<GeoPlace> {
    throw new BrowseFnError({
      code: 'UNSUPPORTED_PROVIDER_CAPABILITY',
      message: 'Provider nominatim does not support full place-details retrieval.',
      provider: this.name,
    });
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.userAgent;
  }

  private async fetchSearch(
    query: string,
    limit = 5,
    box?: number[],
    components?: GeocodeOptions['components']
  ): Promise<NominatimSearchResult[]> {
    const endpoint = this.config.endpoint || 'https://nominatim.openstreetmap.org';
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      addressdetails: '1',
      limit: String(limit),
    });

    if (components?.country) params.set('countrycodes', components.country);
    if (components?.locality || components?.postalCode) {
      // Structured address components cannot be combined with Nominatim's q.
      params.delete('q');
      params.set('street', query);
      if (components.locality) params.set('city', components.locality);
      if (components.postalCode) params.set('postalcode', components.postalCode);
    }
    if (box) { params.set('bounded', '1'); params.set('viewbox', box.join(',')); }

    const response = await fetch(`${endpoint}/search?${params}`, {
      headers: { 'User-Agent': this.config.userAgent },
    });

    if (!response.ok) {
      throw new Error(`Nominatim API error: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as NominatimSearchResult[];
  }

  private toAddress(
    address: Record<string, string> | undefined,
    formatted: string | undefined
  ): GeoAddress {
    return {
      formatted: formatted || '',
      street: address?.road,
      streetNumber: address?.house_number,
      city: address?.city || address?.town || address?.village,
      state: address?.state,
      country: address?.country,
      postalCode: address?.postcode,
      countryCode: address?.country_code,
      neighborhood: address?.neighbourhood,
      district: address?.suburb,
    };
  }
}
