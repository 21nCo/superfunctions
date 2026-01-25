/**
 * Nominatim (OpenStreetMap) provider for geocoding
 */

import type {
  GeoProvider,
  GeoLocation,
  ReverseGeocodeResult,
  GeocodeOptions,
  GeoAddress
} from '../../core/types.js';

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
      addressdetails: '1'
    });

    const response = await fetch(`${endpoint}/reverse?${params}`, {
      headers: {
        'User-Agent': this.config.userAgent
      }
    });

    if (!response.ok) {
      throw new Error(`Nominatim API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    const address: GeoAddress = {
      formatted: data.display_name,
      street: data.address.road,
      streetNumber: data.address.house_number,
      city: data.address.city || data.address.town || data.address.village,
      state: data.address.state,
      country: data.address.country,
      postalCode: data.address.postcode,
      countryCode: data.address.country_code,
      neighborhood: data.address.neighbourhood,
      district: data.address.suburb
    };

    return {
      location,
      address,
      placeId: data.place_id?.toString(),
      provider: this.name
    };
  }

  async geocode(address: string, options: GeocodeOptions = {}): Promise<ReverseGeocodeResult[]> {
    const endpoint = this.config.endpoint || 'https://nominatim.openstreetmap.org';

    const params = new URLSearchParams({
      q: address,
      format: 'json',
      addressdetails: '1',
      ...(options.limit && { limit: options.limit.toString() })
    });

    const response = await fetch(`${endpoint}/search?${params}`, {
      headers: {
        'User-Agent': this.config.userAgent
      }
    });

    if (!response.ok) {
      throw new Error(`Nominatim API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    return data.map((result: any) => {
      const geoAddress: GeoAddress = {
        formatted: result.display_name,
        street: result.address.road,
        streetNumber: result.address.house_number,
        city: result.address.city || result.address.town || result.address.village,
        state: result.address.state,
        country: result.address.country,
        postalCode: result.address.postcode,
        countryCode: result.address.country_code,
        neighborhood: result.address.neighbourhood,
        district: result.address.suburb
      };

      return {
        location: {
          lat: parseFloat(result.lat),
          lng: parseFloat(result.lon)
        },
        address: geoAddress,
        placeId: result.place_id?.toString(),
        provider: this.name
      };
    });
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.userAgent;
  }
}
