/**
 * Geocoding interface
 */

import type {
  GeoProvider,
  GeoLocation,
  ReverseGeocodeResult,
  GeocodeOptions,
  GeoSearchOptions,
  GeoPlace
} from '../core/types.js';
import { ProviderManager } from '../core/provider-manager.js';
import { CacheManager } from '../core/cache-manager.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { validateGeoLocation } from '../utils/validation.js';

export class Geocoder {
  private providerManager: ProviderManager<GeoProvider>;

  constructor(
    private cache?: CacheManager,
    private rateLimiter?: RateLimiter,
    defaultProvider?: string,
    fallbackChain?: string[] = []
  ) {
    this.providerManager = new ProviderManager(defaultProvider, fallbackChain);
  }

  /**
   * Register a geo provider
   */
  registerProvider(provider: GeoProvider): void {
    this.providerManager.register(provider.name, provider);
  }

  /**
   * Reverse geocode (coordinates to address)
   */
  async reverseGeocode(
    location: GeoLocation,
    options: { provider?: string; cache?: boolean } = {}
  ): Promise<ReverseGeocodeResult> {
    validateGeoLocation(location);

    // Check cache
    if (options.cache && this.cache) {
      const cached = await this.cache.get<ReverseGeocodeResult>(
        'reverseGeocode',
        `${location.lat},${location.lng}`,
        options
      );
      if (cached) {
        return { ...cached, cached: true };
      }
    }

    // Execute with fallback
    const result = await this.providerManager.executeWithFallback(
      options.provider,
      async (provider, providerName) => {
        // Check rate limit
        if (this.rateLimiter) {
          await this.rateLimiter.waitForLimit(providerName);
        }

        return await provider.reverseGeocode(location);
      }
    );

    // Cache result
    if (options.cache && this.cache) {
      await this.cache.set(
        'reverseGeocode',
        `${location.lat},${location.lng}`,
        result,
        options
      );
    }

    return result;
  }

  /**
   * Forward geocode (address to coordinates)
   */
  async geocode(
    address: string,
    options: GeocodeOptions = {}
  ): Promise<ReverseGeocodeResult[]> {
    // Check cache
    if (options.cache && this.cache) {
      const cached = await this.cache.get<ReverseGeocodeResult[]>(
        'geocode',
        address,
        options
      );
      if (cached) {
        return cached.map(r => ({ ...r, cached: true }));
      }
    }

    // Execute with fallback
    const result = await this.providerManager.executeWithFallback(
      options.provider,
      async (provider, providerName) => {
        // Check rate limit
        if (this.rateLimiter) {
          await this.rateLimiter.waitForLimit(providerName);
        }

        return await provider.geocode(address, options);
      }
    );

    // Cache result
    if (options.cache && this.cache) {
      await this.cache.set('geocode', address, result, options);
    }

    return result;
  }

  /**
   * Search for places
   */
  async search(options: GeoSearchOptions): Promise<GeoPlace[]> {
    // Check cache
    if (options.cache && this.cache) {
      const cached = await this.cache.get<GeoPlace[]>(
        'geoSearch',
        options.query,
        options
      );
      if (cached) {
        return cached;
      }
    }

    // Execute with fallback
    const result = await this.providerManager.executeWithFallback(
      options.provider,
      async (provider, providerName) => {
        if (!provider.search) {
          throw new Error(`Provider ${providerName} does not support search`);
        }

        // Check rate limit
        if (this.rateLimiter) {
          await this.rateLimiter.waitForLimit(providerName);
        }

        return await provider.search(options);
      }
    );

    // Cache result
    if (options.cache && this.cache) {
      await this.cache.set('geoSearch', options.query, result, options);
    }

    return result;
  }

  /**
   * Get place details
   */
  async getPlaceDetails(
    placeId: string,
    options: { provider?: string; fields?: string[]; cache?: boolean } = {}
  ): Promise<GeoPlace> {
    // Check cache
    if (options.cache && this.cache) {
      const cached = await this.cache.get<GeoPlace>(
        'placeDetails',
        placeId,
        options
      );
      if (cached) {
        return cached;
      }
    }

    // Execute with fallback
    const result = await this.providerManager.executeWithFallback(
      options.provider,
      async (provider, providerName) => {
        if (!provider.getPlaceDetails) {
          throw new Error(`Provider ${providerName} does not support place details`);
        }

        // Check rate limit
        if (this.rateLimiter) {
          await this.rateLimiter.waitForLimit(providerName);
        }

        return await provider.getPlaceDetails(placeId, options.fields);
      }
    );

    // Cache result
    if (options.cache && this.cache) {
      await this.cache.set('placeDetails', placeId, result, options);
    }

    return result;
  }

  /**
   * List available providers
   */
  async listProviders(): Promise<string[]> {
    return await this.providerManager.listAvailable();
  }
}
