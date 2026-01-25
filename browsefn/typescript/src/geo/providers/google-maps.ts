/**
 * Google Maps geocoding provider
 */

import type {
  GeoProvider,
  GeoLocation,
  GeoAddress,
  ReverseGeocodeResult,
  GeocodeOptions,
  GeoSearchOptions,
  GeoPlace,
  ProviderConfig,
} from "../core/types.js";

export class GoogleMapsProvider implements GeoProvider {
  name = "google-maps";

  constructor(private config: ProviderConfig) {}

  async reverseGeocode(location: GeoLocation): Promise<ReverseGeocodeResult> {
    if (!this.config.apiKey) {
      throw new Error("Google Maps API key is required");
    }

    const params = new URLSearchParams({
      latlng: `${location.lat},${location.lng}`,
      key: this.config.apiKey,
    });

    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${params}`
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== "OK") {
      throw new Error(`Google Maps API error: ${data.status}`);
    }

    const result = data.results[0];
    const components: Record<string, any> = {};

    for (const component of result.address_components || []) {
      components[component.types[0]] = component;
    }

    const address: GeoAddress = {
      formatted: result.formatted_address || "",
      street: components.route?.long_name,
      streetNumber: components.street_number?.long_name,
      city:
        components.locality?.long_name ||
        components.administrative_area_level_2?.long_name,
      state: components.administrative_area_level_1?.long_name,
      country: components.country?.long_name,
      postalCode: components.postal_code?.long_name,
      countryCode: components.country?.short_name,
      neighborhood: components.neighborhood?.long_name,
      district: components.sublocality?.long_name,
    };

    return {
      location,
      address,
      placeId: result.place_id,
      provider: this.name,
    };
  }

  async geocode(
    address: string,
    options: GeocodeOptions
  ): Promise<ReverseGeocodeResult[]> {
    if (!this.config.apiKey) {
      throw new Error("Google Maps API key is required");
    }

    const params: Record<string, string> = {
      address,
      key: this.config.apiKey,
    };

    // Apply component filters
    if (options.components) {
      const filters: string[] = [];
      if (options.components.country) {
        filters.push(`country:${options.components.country}`);
      }
      if (options.components.postalCode) {
        filters.push(`postal_code:${options.components.postalCode}`);
      }
      if (filters.length > 0) {
        params.components = filters.join("|");
      }
    }

    // Apply bounds
    if (options.bounds) {
      params.bounds = `${options.bounds.sw.lat},${options.bounds.sw.lng}|${options.bounds.ne.lat},${options.bounds.ne.lng}`;
    }

    const searchParams = new URLSearchParams(params);
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${searchParams}`
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== "OK") {
      throw new Error(`Google Maps API error: ${data.status}`);
    }

    const results: ReverseGeocodeResult[] = [];
    const limit = options.limit || 5;

    for (const result of data.results.slice(0, limit)) {
      const locData = result.geometry?.location || {};
      const location: GeoLocation = {
        lat: locData.lat || 0,
        lng: locData.lng || 0,
      };

      const components: Record<string, any> = {};
      for (const component of result.address_components || []) {
        components[component.types[0]] = component;
      }

      const addr: GeoAddress = {
        formatted: result.formatted_address || "",
        street: components.route?.long_name,
        streetNumber: components.street_number?.long_name,
        city: components.locality?.long_name,
        state: components.administrative_area_level_1?.long_name,
        country: components.country?.long_name,
        postalCode: components.postal_code?.long_name,
        countryCode: components.country?.short_name,
      };

      results.push({
        location,
        address: addr,
        placeId: result.place_id,
        provider: this.name,
      });
    }

    return results;
  }

  async search(options: GeoSearchOptions): Promise<GeoPlace[]> {
    if (!this.config.apiKey) {
      throw new Error("Google Maps API key is required");
    }

    const params: Record<string, string> = {
      query: options.query,
      key: this.config.apiKey,
    };

    // Add location bias
    if (options.center) {
      params.location = `${options.center.lat},${options.center.lng}`;
      if (options.radius) {
        params.radius = options.radius.toString();
      }
    }

    // Add type filter
    if (options.types && options.types.length > 0) {
      const typeMap: Record<string, string> = {
        address: "street_address",
        city: "locality",
        country: "country",
        poi: "point_of_interest",
        postcode: "postal_code",
      };
      params.type = typeMap[options.types[0]] || options.types[0];
    }

    const searchParams = new URLSearchParams(params);
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/place/textsearch/json?${searchParams}`
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== "OK") {
      throw new Error(`Google Maps API error: ${data.status}`);
    }

    const results: GeoPlace[] = [];
    const limit = options.limit || 20;

    for (const result of data.results.slice(0, limit)) {
      const locData = result.geometry?.location || {};
      const location: GeoLocation = {
        lat: locData.lat || 0,
        lng: locData.lng || 0,
      };

      const address: GeoAddress = {
        formatted: result.formatted_address || "",
      };

      const place: GeoPlace = {
        id: result.place_id || "",
        name: result.name || "",
        location,
        address,
        types: result.types,
        rating: result.rating,
        provider: this.name,
      };

      results.push(place);
    }

    return results;
  }

  async getPlaceDetails(placeId: string, fields?: string[]): Promise<GeoPlace> {
    if (!this.config.apiKey) {
      throw new Error("Google Maps API key is required");
    }

    const requestedFields = fields || [
      "name",
      "formatted_address",
      "geometry",
      "rating",
      "opening_hours",
    ];

    const params = new URLSearchParams({
      place_id: placeId,
      fields: requestedFields.join(","),
      key: this.config.apiKey,
    });

    const response = await fetch(
      `https://maps.googleapis.com/maps/api/place/details/json?${params}`
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== "OK") {
      throw new Error(`Google Maps API error: ${data.status}`);
    }

    const result = data.result;
    const locData = result.geometry?.location || {};
    const location: GeoLocation = {
      lat: locData.lat || 0,
      lng: locData.lng || 0,
    };

    const address: GeoAddress = {
      formatted: result.formatted_address || "",
    };

    const openingHours = result.opening_hours
      ? {
          open: result.opening_hours.open_now || false,
          periods: undefined, // Simplified - full implementation would parse periods
        }
      : undefined;

    return {
      id: placeId,
      name: result.name || "",
      location,
      address,
      types: result.types,
      rating: result.rating,
      reviews: result.user_ratings_total,
      photos: result.photos?.map((p: any) => p.photo_reference),
      website: result.website,
      phone: result.formatted_phone_number,
      openingHours,
      provider: this.name,
    };
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey;
  }
}
