/**
 * Geocoding interface.
 */

import { BrowseFnError, isBrowseFnError } from '../core/errors.js';
import { normalizeGeoProviderId } from '../core/provider-registry.js';
import type {
  GeocodeOptions,
  GeoLocation,
  GeoPlace,
  GeoProvider,
  GeoSearchOptions,
  ReverseGeocodeResult,
} from '../core/types.js';
import { CacheManager } from '../core/cache-manager.js';
import { ProviderManager } from '../core/provider-manager.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { validateGeoLocation } from '../utils/validation.js';

interface ServiceHooks {
  onProviderFallback?: (input: { from: string; to: string; error: Error }) => void;
}

interface PlaceDetailsOptions {
  provider?: string;
  fields?: string[];
  cache?: boolean;
}

export class Geocoder {
  private providerManager: ProviderManager<GeoProvider>;

  constructor(
    private cache?: CacheManager,
    private rateLimiter?: RateLimiter,
    defaultProvider?: string,
    fallbackChain: string[] = [],
    private hooks?: ServiceHooks
  ) {
    this.providerManager = new ProviderManager(
      normalizeGeoProviderId(defaultProvider) ?? defaultProvider,
      fallbackChain
        .map((provider) => normalizeGeoProviderId(provider) ?? provider)
        .filter((provider): provider is string => Boolean(provider))
    );
  }

  registerProvider(provider: GeoProvider): void {
    const canonicalName = normalizeGeoProviderId(provider.name) ?? provider.name;
    if (provider.name !== canonicalName) {
      provider.name = canonicalName;
    }
    this.providerManager.register(canonicalName, provider);
  }

  async reverseGeocode(
    location: GeoLocation,
    options: { provider?: string; cache?: boolean } = {}
  ): Promise<ReverseGeocodeResult> {
    validateGeoLocation(location);
    const provider = this.normalizeRequestedProvider(options.provider);
    const cacheKey = `${location.lat},${location.lng}`;

    if (options.cache && this.cache) {
      const cached = await this.cache.get<ReverseGeocodeResult>(
        'reverseGeocode',
        cacheKey,
        { ...options, provider }
      );
      if (cached) {
        return { ...cached, cached: true, provider: this.normalizeResultProvider(cached.provider) };
      }
    }

    const result = await this.executeWithFallback(
      provider,
      async (geoProvider, providerName) => {
        await this.rateLimiter?.waitForLimit(providerName);
        const reverseResult = await geoProvider.reverseGeocode(location);
        return this.normalizeReverseResult(reverseResult, providerName);
      }
    );

    if (options.cache && this.cache) {
      await this.cache.set('reverseGeocode', cacheKey, result, { ...options, provider });
    }

    return result;
  }

  async geocode(
    address: string,
    options: GeocodeOptions = {}
  ): Promise<ReverseGeocodeResult[]> {
    const provider = this.normalizeRequestedProvider(options.provider);

    if (options.cache && this.cache) {
      const cached = await this.cache.get<ReverseGeocodeResult[]>(
        'geocode',
        address,
        { ...options, provider }
      );
      if (cached) {
        return cached.map((result) => ({
          ...result,
          cached: true,
          provider: this.normalizeResultProvider(result.provider),
        }));
      }
    }

    const results = await this.executeWithFallback(
      provider,
      async (geoProvider, providerName) => {
        await this.rateLimiter?.waitForLimit(providerName);
        const geocodeResults = await geoProvider.geocode(address, {
          ...options,
          provider: providerName,
        });
        return geocodeResults.map((result) =>
          this.normalizeReverseResult(result, providerName)
        );
      }
    );

    if (options.cache && this.cache) {
      await this.cache.set('geocode', address, results, { ...options, provider });
    }

    return results;
  }

  async search(options: GeoSearchOptions): Promise<GeoPlace[]> {
    const provider = this.normalizeRequestedProvider(options.provider);

    if (options.cache && this.cache) {
      const cached = await this.cache.get<GeoPlace[]>(
        'geoSearch',
        options.query,
        { ...options, provider }
      );
      if (cached) {
        return cached.map((place) => this.normalizePlace(place));
      }
    }

    const results = await this.executeWithFallback(
      provider,
      async (geoProvider, providerName) => {
        if (!geoProvider.search) {
          throw new BrowseFnError({
            code: 'UNSUPPORTED_PROVIDER_CAPABILITY',
            message: `Provider ${providerName} does not support search.`,
            provider: providerName,
          });
        }

        await this.rateLimiter?.waitForLimit(providerName);
        const places = await geoProvider.search({
          ...options,
          provider: providerName,
        });
        return places.map((place) => this.normalizePlace(place, providerName));
      }
    );

    if (options.cache && this.cache) {
      await this.cache.set('geoSearch', options.query, results, { ...options, provider });
    }

    return results;
  }

  async getPlaceDetails(
    placeId: string,
    options: PlaceDetailsOptions = {}
  ): Promise<GeoPlace> {
    const provider = this.normalizeRequestedProvider(options.provider);

    if (options.cache && this.cache) {
      const cached = await this.cache.get<GeoPlace>(
        'placeDetails',
        placeId,
        { ...options, provider }
      );
      if (cached) {
        return this.normalizePlace(cached);
      }
    }

    const result = await this.executeWithFallback(
      provider,
      async (geoProvider, providerName) => {
        if (!geoProvider.getPlaceDetails) {
          throw new BrowseFnError({
            code: 'UNSUPPORTED_PROVIDER_CAPABILITY',
            message:
              providerName === 'nominatim'
                ? 'Provider nominatim does not support full place-details retrieval.'
                : `Provider ${providerName} does not support place-details retrieval.`,
            provider: providerName,
          });
        }

        await this.rateLimiter?.waitForLimit(providerName);
        const place = await geoProvider.getPlaceDetails(placeId, options.fields);
        return this.normalizePlace(place, providerName);
      }
    );

    if (options.cache && this.cache) {
      await this.cache.set('placeDetails', placeId, result, { ...options, provider });
    }

    return result;
  }

  async listProviders(): Promise<string[]> {
    return this.providerManager.listAvailable();
  }

  private async executeWithFallback<TResult>(
    requestedProvider: string | undefined,
    executor: (provider: GeoProvider, providerName: string) => Promise<TResult>
  ): Promise<TResult> {
    let fallbackFrom: string | undefined;
    let result: TResult;

    try {
      result = await this.providerManager.executeWithFallback(
        requestedProvider,
        async (provider, providerName) => executor(provider, providerName),
        (from, to, error) => {
          fallbackFrom ??= from;
          this.hooks?.onProviderFallback?.({ from, to, error });
        }
      );
    } catch (error) {
      throw this.normalizeError(error, requestedProvider);
    }

    if (result && typeof result === 'object') {
      Object.defineProperty(result, '__browseFnFallbackFrom', {
        value: fallbackFrom,
        enumerable: false,
        configurable: true,
      });
    }

    return result;
  }

  private normalizeRequestedProvider(provider?: string): string | undefined {
    if (!provider) {
      return undefined;
    }

    const canonical = normalizeGeoProviderId(provider);
    if (canonical) {
      return canonical;
    }

    if (this.providerManager.get(provider)) {
      return provider;
    }

    throw new BrowseFnError({
      code: 'UNSUPPORTED_PROVIDER',
      message: `Provider ${provider} is not registered.`,
      provider,
    });
  }

  private normalizeReverseResult(
    result: ReverseGeocodeResult,
    providerName?: string
  ): ReverseGeocodeResult {
    return {
      ...result,
      provider: this.normalizeResultProvider(providerName ?? result.provider),
    };
  }

  private normalizePlace(place: GeoPlace, providerName?: string): GeoPlace {
    return {
      ...place,
      provider: this.normalizeResultProvider(providerName ?? place.provider),
    };
  }

  private normalizeResultProvider(providerName?: string): string {
    return normalizeGeoProviderId(providerName) ?? providerName ?? 'unknown';
  }

  private normalizeError(
    error: unknown,
    providerName?: string
  ): BrowseFnError {
    if (isBrowseFnError(error)) {
      return error;
    }

    const err = error instanceof Error ? error : new Error(String(error));
    const message = err.message.replace(/^All providers failed:\s*/, '');

    if (message.includes('does not support full place-details retrieval')) {
      return new BrowseFnError({
        code: 'UNSUPPORTED_PROVIDER_CAPABILITY',
        message: 'Provider nominatim does not support full place-details retrieval.',
        provider: providerName ?? 'nominatim',
      });
    }

    if (
      message.includes('does not support place-details retrieval') ||
      message.includes('does not support search')
    ) {
      return new BrowseFnError({
        code: 'UNSUPPORTED_PROVIDER_CAPABILITY',
        message,
        provider: providerName,
      });
    }

    if (/timed out|timeout/i.test(message)) {
      return new BrowseFnError({
        code: 'UPSTREAM_TIMEOUT',
        message,
        provider: providerName,
      });
    }

    if (message.includes('not available')) {
      return new BrowseFnError({
        code: 'PROVIDER_UNAVAILABLE',
        message,
        provider: providerName,
      });
    }

    return new BrowseFnError({
      code: 'PROVIDER_ERROR',
      message,
      provider: providerName,
    });
  }
}
