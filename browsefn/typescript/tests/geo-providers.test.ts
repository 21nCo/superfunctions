import { describe, expect, it, vi } from 'vitest';

import { GoogleMapsProvider } from '../src/geo/providers/google-maps.js';
import { MapboxProvider } from '../src/geo/providers/mapbox.js';
import { NominatimProvider } from '../src/geo/providers/nominatim.js';

describe('Geo providers', () => {
  it('normalizes Google Maps reverse geocoding results', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'OK',
        results: [
          {
            formatted_address: 'New York, NY, USA',
            place_id: 'gm-place-1',
            geometry: { location: { lat: 40.7128, lng: -74.006 } },
            address_components: [
              { types: ['locality'], long_name: 'New York' },
              { types: ['administrative_area_level_1'], long_name: 'New York' },
              { types: ['country'], long_name: 'United States', short_name: 'US' },
            ],
          },
        ],
      }),
    } as Response);

    const provider = new GoogleMapsProvider({ apiKey: 'gm-key' });
    const result = await provider.reverseGeocode({ lat: 40.7128, lng: -74.006 });

    expect(result).toMatchObject({
      provider: 'google-maps',
      location: { lat: 40.7128, lng: -74.006 },
      address: { formatted: 'New York, NY, USA' },
      placeId: 'gm-place-1',
    });
  });

  it('normalizes Mapbox search and place-details results', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          features: [
            {
              id: 'place-123',
              text: 'Coffee A',
              place_name: 'Coffee A, New York, NY, USA',
              center: [-74.006, 40.7128],
              place_type: ['poi'],
              context: [
                { id: 'place.1', text: 'New York' },
                { id: 'region.1', text: 'New York' },
                { id: 'country.1', text: 'United States' },
              ],
            },
            {
              id: 'place-456',
              text: 'Coffee B',
              place_name: 'Coffee B, New York, NY, USA',
              center: [-74.005, 40.713],
              place_type: ['poi'],
              context: [
                { id: 'place.1', text: 'New York' },
                { id: 'region.1', text: 'New York' },
                { id: 'country.1', text: 'United States' },
              ],
            },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          features: [
            {
              id: 'place-123',
              text: 'Coffee A',
              place_name: 'Coffee A, New York, NY, USA',
              center: [-74.006, 40.7128],
              place_type: ['poi'],
              context: [
                { id: 'place.1', text: 'New York' },
                { id: 'region.1', text: 'New York' },
                { id: 'country.1', text: 'United States' },
              ],
            },
          ],
        }),
      } as Response);

    const provider = new MapboxProvider({ apiKey: 'mapbox-key' });
    const searchResults = await provider.search({
      query: 'coffee shops',
      center: { lat: 40.7128, lng: -74.006 },
      provider: 'mapbox',
      limit: 2,
    });
    const details = await provider.getPlaceDetails('place-123', ['name', 'address', 'rating']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(searchResults.map((item) => ({ id: item.id, provider: item.provider }))).toEqual([
      { id: 'place-123', provider: 'mapbox' },
      { id: 'place-456', provider: 'mapbox' },
    ]);
    expect(details).toMatchObject({
      id: 'place-123',
      provider: 'mapbox',
      name: 'Coffee A',
    });
  });

  it('supports Nominatim search normalization', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [
        {
          place_id: 99,
          display_name: 'Coffee Spot, New York, NY, USA',
          lat: '40.7128',
          lon: '-74.0060',
          class: 'amenity',
          type: 'cafe',
          address: {
            amenity: 'Coffee Spot',
            city: 'New York',
            state: 'New York',
            country: 'United States',
          },
        },
      ],
    } as Response);

    const provider = new NominatimProvider({ userAgent: 'Test/1.0' });
    const results = await provider.search({
      query: 'coffee shops',
      provider: 'nominatim',
    });

    expect(results).toEqual([
      expect.objectContaining({
        id: '99',
        name: 'Coffee Spot',
        provider: 'nominatim',
        types: ['amenity', 'cafe'],
      }),
    ]);
  });

  it('rejects full place-details retrieval for Nominatim deterministically', async () => {
    const provider = new NominatimProvider({ userAgent: 'Test/1.0' });

    await expect(provider.getPlaceDetails('place-123', ['name'])).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER_CAPABILITY',
      message: 'Provider nominatim does not support full place-details retrieval.',
    });
  });
});
