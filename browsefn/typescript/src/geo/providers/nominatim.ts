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
    const results = await this.fetchSearch(address, options.limit);
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
    const results = await this.fetchSearch(options.query, options.limit);
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
    limit = 5
  ): Promise<NominatimSearchResult[]> {
    const endpoint = this.config.endpoint || 'https://nominatim.openstreetmap.org';
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      addressdetails: '1',
      limit: String(limit),
    });

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
