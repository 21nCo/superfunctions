import { describe, expect, it } from 'vitest';

import type {
  GeoLocation,
  GeoPlace,
  GeoProvider,
  ReverseGeocodeResult,
} from '../src/core/types.js';
import { Geocoder } from '../src/geo/geocoder.js';
import { NominatimProvider } from '../src/geo/providers/nominatim.js';

class MockGeoProvider implements GeoProvider {
  constructor(
    public name: string,
    private handlers: {
      reverseGeocode?: (location: GeoLocation) => Promise<ReverseGeocodeResult>;
      geocode?: (address: string) => Promise<ReverseGeocodeResult[]>;
      search?: () => Promise<GeoPlace[]>;
      getPlaceDetails?: (placeId: string) => Promise<GeoPlace>;
    } = {}
  ) {}

  async reverseGeocode(location: GeoLocation): Promise<ReverseGeocodeResult> {
    if (this.handlers.reverseGeocode) {
      return this.handlers.reverseGeocode(location);
    }
    return {
      location,
      address: { formatted: 'Fallback' },
      provider: this.name,
    };
  }

  async geocode(address: string): Promise<ReverseGeocodeResult[]> {
    if (this.handlers.geocode) {
      return this.handlers.geocode(address);
    }
    return [
      {
        location: { lat: 1, lng: 2 },
        address: { formatted: address },
        provider: this.name,
      },
    ];
  }

  async search(): Promise<GeoPlace[]> {
    return this.handlers.search ? this.handlers.search() : [];
  }

  async getPlaceDetails(placeId: string): Promise<GeoPlace> {
    if (!this.handlers.getPlaceDetails) {
      throw new Error('unsupported');
    }
    return this.handlers.getPlaceDetails(placeId);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

describe('Geocoder', () => {
  it('normalizes googleMaps input to google-maps output ids', async () => {
    const geocoder = new Geocoder();
    geocoder.registerProvider(
      new MockGeoProvider('google-maps', {
        reverseGeocode: async (location) => ({
          location,
          address: { formatted: 'New York, NY, USA' },
          provider: 'google-maps',
        }),
      })
    );

    const result = await geocoder.reverseGeocode(
      { lat: 40.7128, lng: -74.006 },
      { provider: 'googleMaps' }
    );

    expect(result).toEqual({
      location: { lat: 40.7128, lng: -74.006 },
      address: { formatted: 'New York, NY, USA' },
      provider: 'google-maps',
    });
  });

  it('returns canonical validation errors for invalid coordinates', async () => {
    const geocoder = new Geocoder();

    await expect(
      geocoder.reverseGeocode(
        { lat: 120, lng: -74.006 },
        { provider: 'nominatim' }
      )
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'Latitude must be between -90 and 90.',
    });
  });

  it('returns sorted canonical provider ids', async () => {
    const geocoder = new Geocoder();
    geocoder.registerProvider(new MockGeoProvider('mapbox'));
    geocoder.registerProvider(new MockGeoProvider('googleMaps'));
    geocoder.registerProvider(new MockGeoProvider('nominatim'));

    expect(await geocoder.listProviders()).toEqual([
      'google-maps',
      'mapbox',
      'nominatim',
    ]);
  });

  it('normalizes geo search and place-details results into canonical GeoPlace models', async () => {
    const geocoder = new Geocoder();
    geocoder.registerProvider(
      new MockGeoProvider('mapbox', {
        search: async () => [
          {
            id: 'place-123',
            name: 'Coffee A',
            location: { lat: 40.7, lng: -74.0 },
            address: { formatted: 'A Street' },
            provider: 'mapbox',
          },
          {
            id: 'place-456',
            name: 'Coffee B',
            location: { lat: 40.71, lng: -74.01 },
            address: { formatted: 'B Street' },
            provider: 'mapbox',
          },
        ],
        getPlaceDetails: async (placeId) => ({
          id: placeId,
          name: 'Coffee A',
          location: { lat: 40.7, lng: -74.0 },
          address: { formatted: 'A Street' },
          rating: 4.5,
          provider: 'mapbox',
        }),
      })
    );

    const searchResults = await geocoder.search({
      query: 'coffee shops',
      center: { lat: 40.7128, lng: -74.006 },
      provider: 'mapbox',
      limit: 2,
    });
    const details = await geocoder.getPlaceDetails('place-123', {
      provider: 'mapbox',
      fields: ['name', 'address', 'rating'],
    });

    expect(searchResults.map((item) => ({ id: item.id, provider: item.provider }))).toEqual([
      { id: 'place-123', provider: 'mapbox' },
      { id: 'place-456', provider: 'mapbox' },
    ]);
    expect(details).toMatchObject({
      id: 'place-123',
      provider: 'mapbox',
      rating: 4.5,
    });
  });

  it('fails deterministically for nominatim full place-details retrieval', async () => {
    const geocoder = new Geocoder();
    geocoder.registerProvider(new NominatimProvider({ userAgent: 'Test/1.0' }));

    await expect(
      geocoder.getPlaceDetails('place-123', {
        provider: 'nominatim',
        fields: ['name', 'address', 'rating'],
      })
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER_CAPABILITY',
      message: 'Provider nominatim does not support full place-details retrieval.',
    });
  });
});
