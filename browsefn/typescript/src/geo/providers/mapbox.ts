/**
 * Mapbox geocoding provider
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
} from "../../core/types.js";

export class MapboxProvider implements GeoProvider {
  name = "mapbox";
  private baseUrl = "https://api.mapbox.com/geocoding/v5/mapbox.places";

  constructor(private config: ProviderConfig) {}

  async reverseGeocode(location: GeoLocation): Promise<ReverseGeocodeResult> {
    if (!this.config.apiKey) {
      throw new Error("Mapbox API key is required");
    }

    const params = new URLSearchParams({
      access_token: this.config.apiKey,
    });

    const response = await fetch(
      `${this.baseUrl}/${location.lng},${location.lat}.json?${params}`
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (!data.features || data.features.length === 0) {
      throw new Error("No results found");
    }

    const result = data.features[0];
    const components: Record<string, string> = {};

    for (const ctx of result.context || []) {
      const ctxType = ctx.id.split(".")[0];
      components[ctxType] = ctx.text;
    }

    const address: GeoAddress = {
      formatted: result.place_name || "",
      street: result.place_type?.[0] === "address" ? result.text : undefined,
      city: components.place,
      state: components.region,
      country: components.country,
      postalCode: components.postcode,
    };

    return {
      location,
      address,
      placeId: result.id,
      provider: this.name,
    };
  }

  async geocode(
    address: string,
    options: GeocodeOptions
  ): Promise<ReverseGeocodeResult[]> {
    if (!this.config.apiKey) {
      throw new Error("Mapbox API key is required");
    }

    const params: Record<string, string> = {
      access_token: this.config.apiKey,
      limit: (options.limit || 5).toString(),
    };

    // Apply bounds
    if (options.bounds) {
      const bbox = `${options.bounds.sw.lng},${options.bounds.sw.lat},${options.bounds.ne.lng},${options.bounds.ne.lat}`;
      params.bbox = bbox;
    }

    // Apply country filter
    if (options.components?.country) {
      params.country = options.components.country.toLowerCase();
    }

    const searchParams = new URLSearchParams(params);
    const response = await fetch(
      `${this.baseUrl}/${encodeURIComponent(address)}.json?${searchParams}`
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const results: ReverseGeocodeResult[] = [];

    for (const result of data.features || []) {
      const coords = result.center || [0, 0];
      const location: GeoLocation = {
        lat: coords[1],
        lng: coords[0],
      };

      const components: Record<string, string> = {};
      for (const ctx of result.context || []) {
        const ctxType = ctx.id.split(".")[0];
        components[ctxType] = ctx.text;
      }

      const addr: GeoAddress = {
        formatted: result.place_name || "",
        street: result.place_type?.[0] === "address" ? result.text : undefined,
        city: components.place,
        state: components.region,
        country: components.country,
        postalCode: components.postcode,
      };

      results.push({
        location,
        address: addr,
        placeId: result.id,
        provider: this.name,
      });
    }

    return results;
  }

  async search(options: GeoSearchOptions): Promise<GeoPlace[]> {
    if (!this.config.apiKey) {
      throw new Error("Mapbox API key is required");
    }

    const params: Record<string, string> = {
      access_token: this.config.apiKey,
      limit: (options.limit || 20).toString(),
    };

    // Add proximity bias
    if (options.center) {
      params.proximity = `${options.center.lng},${options.center.lat}`;
    }

    // Add type filter
    if (options.types && options.types.length > 0) {
      const typeMap: Record<string, string> = {
        address: "address",
        city: "place",
        country: "country",
        poi: "poi",
        postcode: "postcode",
      };
      params.types = typeMap[options.types[0]] || "poi";
    }

    const searchParams = new URLSearchParams(params);
    const response = await fetch(
      `${this.baseUrl}/${encodeURIComponent(options.query)}.json?${searchParams}`
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const results: GeoPlace[] = [];

    for (const result of data.features || []) {
      const coords = result.center || [0, 0];
      const location: GeoLocation = {
        lat: coords[1],
        lng: coords[0],
      };

      const components: Record<string, string> = {};
      for (const ctx of result.context || []) {
        const ctxType = ctx.id.split(".")[0];
        components[ctxType] = ctx.text;
      }

      const address: GeoAddress = {
        formatted: result.place_name || "",
        city: components.place,
        state: components.region,
        country: components.country,
      };

      const place: GeoPlace = {
        id: result.id || "",
        name: result.text || "",
        location,
        address,
        types: result.place_type,
        provider: this.name,
      };

      results.push(place);
    }

    return results;
  }

  async getPlaceDetails(placeId: string, fields?: string[]): Promise<GeoPlace> {
    if (!this.config.apiKey) {
      throw new Error("Mapbox API key is required");
    }

    const params = new URLSearchParams({
      access_token: this.config.apiKey,
    });

    const response = await fetch(
      `${this.baseUrl}/${encodeURIComponent(placeId)}.json?${params}`
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (!data.features || data.features.length === 0) {
      throw new Error(`Place ${placeId} not found`);
    }

    const result = data.features[0];
    const coords = result.center || [0, 0];
    const location: GeoLocation = {
      lat: coords[1],
      lng: coords[0],
    };

    const components: Record<string, string> = {};
    for (const ctx of result.context || []) {
      const ctxType = ctx.id.split(".")[0];
      components[ctxType] = ctx.text;
    }

    const address: GeoAddress = {
      formatted: result.place_name || "",
      city: components.place,
      state: components.region,
      country: components.country,
    };

    return {
      id: placeId,
      name: result.text || "",
      location,
      address,
      types: result.place_type,
      provider: this.name,
    };
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey;
  }
}
