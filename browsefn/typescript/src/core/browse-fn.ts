/**
 * Main BrowseFn class.
 */

import type {
  BrowseFnConfig,
  BrowseFnEvent,
  DownloadResult,
  EventData,
  EventHandler,
  GeocodeOptions,
  GeoPlace,
  GeoSearchOptions,
  GetPageOptions,
  ImageDownloadOptions,
  ImageSearchOptions,
  ImageSearchResult,
  MetadataOptions,
  MetadataResult,
  Metrics,
  PageResult,
  ProviderConfig,
  RateLimitStatus,
  ReverseGeocodeResult,
} from './types.js';
import { BrowseFnError, isBrowseFnError } from './errors.js';
import { CacheManager } from './cache-manager.js';
import { RateLimiter } from './rate-limiter.js';
import { WebScraper } from '../web/scraper.js';
import { ImageBrowser } from '../images/browser.js';
import { Geocoder } from '../geo/geocoder.js';
import { RetryMiddleware } from '../middleware/retry.js';
import { Logger } from '../middleware/logging.js';
import { MetricsCollector } from '../middleware/metrics.js';

import { CheerioProvider } from '../web/providers/cheerio.js';
import { FirecrawlProvider } from '../web/providers/firecrawl.js';
import { JinaProvider } from '../web/providers/jina.js';
import { PuppeteerProvider } from '../web/providers/puppeteer.js';
import { PlaywrightProvider } from '../web/providers/playwright.js';
import { UnsplashProvider } from '../images/providers/unsplash.js';
import { PixabayProvider } from '../images/providers/pixabay.js';
import { PexelsProvider } from '../images/providers/pexels.js';
import { NominatimProvider } from '../geo/providers/nominatim.js';
import { GoogleMapsProvider } from '../geo/providers/google-maps.js';
import { MapboxProvider } from '../geo/providers/mapbox.js';

export interface OperationResultMeta {
  provider?: string;
  cached?: boolean;
  durationMs?: number;
  fallbackFrom?: string;
}

export const BROWSEFN_RESULT_META_KEY = '__browseFnMeta';

export function getOperationResultMeta(result: unknown): OperationResultMeta | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  return (result as Record<string, unknown>)[BROWSEFN_RESULT_META_KEY] as
    | OperationResultMeta
    | undefined;
}

interface OperationHooks {
  onProviderFallback: (input: { from: string; to: string; error: Error }) => void;
}

interface OperationContext {
  operation: string;
  url?: string;
  provider?: string;
  cacheRequested?: boolean;
}

export class BrowseFn {
  private cacheManager?: CacheManager;
  private rateLimiter?: RateLimiter;
  private retryMiddleware?: RetryMiddleware;
  private readonly logger: Logger;
  private readonly metricsCollector: MetricsCollector;
  private readonly eventHandlers = new Map<BrowseFnEvent, Set<EventHandler>>();

  public web: WebScraper;
  public images: ImageBrowser;
  public geo: Geocoder;
  public cache?: CacheManager;

  constructor(config: BrowseFnConfig = {}) {
    if (config.cache?.enabled) {
      this.cacheManager = new CacheManager(config.cache);
      this.cache = this.cacheManager;
    }

    if (config.rateLimit) {
      this.rateLimiter = new RateLimiter(
        config.rateLimit.global,
        config.rateLimit.perProvider
      );
    }

    if (config.retry?.enabled) {
      this.retryMiddleware = new RetryMiddleware(config.retry);
    }

    this.logger = new Logger();
    this.metricsCollector = new MetricsCollector();

    this.rateLimiter?.onRateLimited((status) => {
      this.recordEvent('rateLimit', {
        operation: 'rateLimit',
        provider: status.provider,
        outcome: 'rate-limited',
        details: {
          remaining: status.remaining,
          resetAt: status.resetAt,
          limit: status.limit,
        },
      });
    });

    const operationHooks: OperationHooks = {
      onProviderFallback: ({ from, to, error }) => {
        this.recordEvent('provider.fallback', {
          operation: 'provider.fallback',
          provider: to,
          outcome: 'fallback',
          fallbackFrom: from,
          fallbackTo: to,
          error: this.toSerializableError(error),
        });
      },
    };

    this.web = new WebScraper(
      this.cacheManager,
      this.rateLimiter,
      config.web?.defaultProvider,
      config.web?.fallbackChain,
      operationHooks
    );

    if (config.web?.providers) {
      if (config.web.providers.cheerio) {
        this.web.registerProvider(new CheerioProvider(config.web.providers.cheerio));
      }
      if (config.web.providers.firecrawl) {
        this.web.registerProvider(
          new FirecrawlProvider(config.web.providers.firecrawl)
        );
      }
      if (config.web.providers.jina) {
        this.web.registerProvider(new JinaProvider(config.web.providers.jina));
      }
      if (config.web.providers.puppeteer) {
        this.web.registerProvider(new PuppeteerProvider(config.web.providers.puppeteer));
      }
      if (config.web.providers.playwright) {
        this.web.registerProvider(new PlaywrightProvider(config.web.providers.playwright));
      }
    } else {
      this.web.registerProvider(new CheerioProvider());
    }

    this.images = new ImageBrowser(
      this.cacheManager,
      this.rateLimiter,
      config.images?.defaultProvider,
      [],
      operationHooks
    );

    if (config.images?.providers) {
      if (config.images.providers.unsplash) {
        this.images.registerProvider(
          new UnsplashProvider(this.requireApiKey('unsplash', config.images.providers.unsplash))
        );
      }
      if (config.images.providers.pixabay) {
        this.images.registerProvider(
          new PixabayProvider(this.requireApiKey('pixabay', config.images.providers.pixabay))
        );
      }
      if (config.images.providers.pexels) {
        this.images.registerProvider(
          new PexelsProvider(this.requireApiKey('pexels', config.images.providers.pexels))
        );
      }
    }

    this.geo = new Geocoder(
      this.cacheManager,
      this.rateLimiter,
      config.geo?.defaultProvider,
      [],
      operationHooks
    );

    if (config.geo?.providers) {
      if (config.geo.providers.nominatim) {
        this.geo.registerProvider(
          new NominatimProvider(
            this.requireUserAgent('nominatim', config.geo.providers.nominatim)
          )
        );
      }
      const googleMapsConfig =
        config.geo.providers['google-maps'] ?? config.geo.providers.googleMaps;
      if (googleMapsConfig) {
        this.geo.registerProvider(
          new GoogleMapsProvider(this.requireApiKey('google-maps', googleMapsConfig))
        );
      }
      if (config.geo.providers.mapbox) {
        this.geo.registerProvider(
          new MapboxProvider(this.requireApiKey('mapbox', config.geo.providers.mapbox))
        );
      }
    }

    this.instrumentServices();
  }

  on(event: BrowseFnEvent, handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: BrowseFnEvent, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  async getMetrics(options?: {
    timeRange?: 'last-hour' | 'last-24h' | 'last-7d' | 'all';
    groupBy?: 'provider';
  }): Promise<Metrics> {
    const metrics = this.metricsCollector.getMetrics(options);

    if (this.cacheManager) {
      const cacheStats = await this.cacheManager.getStats();
      metrics.cacheHitRate = cacheStats.hitRate;
    }

    return metrics;
  }

  getRateLimitStatus(provider: string): RateLimitStatus {
    if (!this.rateLimiter) {
      return {
        remaining: Number.POSITIVE_INFINITY,
        resetAt: 0,
        limit: Number.POSITIVE_INFINITY,
        allowed: true,
        provider,
        retryAfterMs: 0,
      };
    }
    return this.rateLimiter.getStatus(provider);
  }

  getLogs(filter?: { event?: BrowseFnEvent; provider?: string; since?: number }): EventData[] {
    return this.logger.getLogs(filter);
  }

  async clearCache(): Promise<void> {
    if (this.cacheManager) {
      await this.cacheManager.clear();
    }
  }

  clearMetrics(): void {
    this.metricsCollector.clear();
  }

  clearLogs(): void {
    this.logger.clear();
  }

  private instrumentServices(): void {
    this.web.getPage = this.wrapOperation<GetPageOptions | undefined, PageResult>(
      'web.getPage',
      this.web.getPage.bind(this.web),
      (url, options) => ({
        operation: 'web.getPage',
        url,
        provider: options?.provider,
        cacheRequested: this.shouldUseCache(options?.cache),
      })
    );

    this.web.getMultipleMetadata = this.wrapOperation<MetadataOptions | undefined, MetadataResult[]>(
      'web.getMultipleMetadata',
      this.web.getMultipleMetadata.bind(this.web),
      (urls, options) => ({
        operation: 'web.getMultipleMetadata',
        url: urls[0],
        cacheRequested: options?.cache === true,
      })
    );

    this.images.search = this.wrapOperation<ImageSearchOptions | undefined, ImageSearchResult>(
      'images.search',
      this.images.search.bind(this.images),
      (query, options) => ({
        operation: 'images.search',
        url: query,
        provider: options?.provider,
        cacheRequested: options?.cache === true,
      })
    );

    this.images.download = this.wrapOperation<ImageDownloadOptions | undefined, DownloadResult>(
      'images.download',
      this.images.download.bind(this.images),
      (url) => ({
        operation: 'images.download',
        url: typeof url === 'string' ? url : url.url,
      })
    );

    this.geo.reverseGeocode = this.wrapOperation<
      { provider?: string; cache?: boolean } | undefined,
      ReverseGeocodeResult
    >('geo.reverseGeocode', this.geo.reverseGeocode.bind(this.geo), (location, options) => ({
      operation: 'geo.reverseGeocode',
      url: `${location.lat},${location.lng}`,
      provider: options?.provider,
      cacheRequested: options?.cache === true,
    }));

    this.geo.geocode = this.wrapOperation<GeocodeOptions | undefined, ReverseGeocodeResult[]>(
      'geo.geocode',
      this.geo.geocode.bind(this.geo),
      (address, options) => ({
        operation: 'geo.geocode',
        url: address,
        provider: options?.provider,
        cacheRequested: options?.cache === true,
      })
    );

    this.geo.search = this.wrapOperation<GeoSearchOptions, GeoPlace[]>(
      'geo.search',
      this.geo.search.bind(this.geo),
      (options) => ({
        operation: 'geo.search',
        url: options.query,
        provider: options.provider,
        cacheRequested: options.cache === true,
      })
    );

    this.geo.getPlaceDetails = this.wrapOperation<
      { provider?: string; fields?: string[]; cache?: boolean } | undefined,
      GeoPlace
    >('geo.getPlaceDetails', this.geo.getPlaceDetails.bind(this.geo), (placeId, options) => ({
      operation: 'geo.getPlaceDetails',
      url: placeId,
      provider: options?.provider,
      cacheRequested: options?.cache === true,
    }));
  }

  private wrapOperation<TOptions, TResult>(
    operation: string,
    fn: (input: any, options?: TOptions) => Promise<TResult>,
    buildContext: (input: any, options?: TOptions) => OperationContext
  ): (input: any, options?: TOptions) => Promise<TResult> {
    return async (input: any, options?: TOptions): Promise<TResult> => {
      const context = buildContext(input, options);
      const requestId = this.createRequestId();
      const startedAt = Date.now();

      this.recordEvent('request', {
        requestId,
        operation,
        url: context.url,
        provider: context.provider,
        details: {
          operation,
        },
      });

      try {
        const result = await this.executeWithRetry(
          () => fn(input, options),
          context,
          requestId
        );

        const meta = this.attachMeta(result, {
          provider: this.resolveProvider(result) ?? context.provider,
          cached: this.resolveCached(result),
          durationMs: this.resolveDuration(result) ?? Date.now() - startedAt,
          fallbackFrom: this.resolveFallbackFrom(result),
        });

        if (context.cacheRequested) {
          this.recordEvent(meta.cached ? 'cache.hit' : 'cache.miss', {
            requestId,
            operation,
            url: context.url,
            provider: meta.provider,
            cached: meta.cached,
          });
        }

        this.metricsCollector.record({
          provider: meta.provider,
          success: true,
          duration: meta.durationMs ?? Date.now() - startedAt,
          cached: meta.cached,
        });

        this.recordEvent('response', {
          requestId,
          operation,
          url: context.url,
          provider: meta.provider,
          duration: meta.durationMs,
          cached: meta.cached,
          fallbackFrom: meta.fallbackFrom,
          outcome: 'success',
        });

        return result;
      } catch (error) {
        const normalizedError = this.normalizeError(error, context);
        const durationMs = Date.now() - startedAt;

        this.metricsCollector.record({
          provider: normalizedError.provider ?? context.provider,
          success: false,
          duration: durationMs,
          cached: false,
        });

        this.recordEvent('error', {
          requestId,
          operation,
          url: context.url,
          provider: normalizedError.provider ?? context.provider,
          duration: durationMs,
          outcome: 'error',
          error: this.toSerializableError(normalizedError),
        });

        throw normalizedError;
      }
    };
  }

  private async executeWithRetry<TResult>(
    fn: () => Promise<TResult>,
    context: OperationContext,
    requestId: string
  ): Promise<TResult> {
    if (!this.retryMiddleware) {
      return fn();
    }

    return this.retryMiddleware.execute(fn, {
      operation: context.operation,
      provider: context.provider,
      onRetryAttempt: ({ attempt, delayMs, error }) => {
        this.recordEvent('request', {
          requestId,
          operation: context.operation,
          url: context.url,
          provider: context.provider,
          retryAttempt: attempt,
          details: {
            delayMs,
            retrying: true,
            reason: error.message,
          },
        });
      },
    });
  }

  private recordEvent(
    event: BrowseFnEvent,
    data: Omit<EventData, 'event' | 'timestamp'>
  ): void {
    const entry = this.logger.log(event, data);
    const handlers = this.eventHandlers.get(event);

    if (handlers) {
      handlers.forEach((handler) => handler(entry));
    }
  }

  private attachMeta<TResult>(result: TResult, meta: OperationResultMeta): OperationResultMeta {
    if (result && typeof result === 'object') {
      Object.defineProperty(result as object, BROWSEFN_RESULT_META_KEY, {
        value: meta,
        enumerable: false,
        configurable: true,
      });
    }

    return meta;
  }

  private resolveProvider(result: unknown): string | undefined {
    if (!result || typeof result !== 'object') {
      return undefined;
    }

    if ('provider' in (result as Record<string, unknown>)) {
      const provider = (result as { provider?: unknown }).provider;
      return typeof provider === 'string' ? provider : undefined;
    }

    if (Array.isArray(result) && result.length > 0) {
      return this.resolveProvider(result[0]);
    }

    return undefined;
  }

  private resolveCached(result: unknown): boolean | undefined {
    if (!result || typeof result !== 'object') {
      return undefined;
    }

    if ('cached' in (result as Record<string, unknown>)) {
      const cached = (result as { cached?: unknown }).cached;
      return typeof cached === 'boolean' ? cached : undefined;
    }

    return undefined;
  }

  private resolveDuration(result: unknown): number | undefined {
    if (!result || typeof result !== 'object') {
      return undefined;
    }

    if ('duration' in (result as Record<string, unknown>)) {
      const duration = (result as { duration?: unknown }).duration;
      return typeof duration === 'number' ? duration : undefined;
    }

    return undefined;
  }

  private resolveFallbackFrom(result: unknown): string | undefined {
    const metaFallback = getOperationResultMeta(result)?.fallbackFrom;
    if (metaFallback) {
      return metaFallback;
    }

    if (result && typeof result === 'object' && '__browseFnFallbackFrom' in result) {
      const fallbackFrom = (result as { __browseFnFallbackFrom?: unknown }).__browseFnFallbackFrom;
      return typeof fallbackFrom === 'string' ? fallbackFrom : undefined;
    }

    return undefined;
  }

  private shouldUseCache(
    cache: boolean | { ttl?: number; key?: string } | undefined
  ): boolean {
    if (typeof cache === 'boolean') {
      return cache;
    }
    return typeof cache === 'object' || this.cacheManager?.isEnabled() === true;
  }

  private normalizeError(error: unknown, context: OperationContext): BrowseFnError {
    if (isBrowseFnError(error)) {
      return error;
    }

    const err = error instanceof Error ? error : new Error(String(error));
    const candidate = err as Error & {
      statusCode?: unknown;
      status?: unknown;
      code?: unknown;
    };

    const statusCode =
      typeof candidate.statusCode === 'number'
        ? candidate.statusCode
        : typeof candidate.status === 'number'
          ? candidate.status
          : undefined;

    if (statusCode === 429 || /rate limit/i.test(err.message)) {
      return new BrowseFnError({
        code: 'RATE_LIMITED',
        message: context.provider
          ? `Rate limit exceeded for provider ${context.provider}.`
          : 'Rate limit exceeded.',
        provider: context.provider,
      });
    }

    if (statusCode === 504 || /timed out|timeout|HTTP 504/i.test(err.message)) {
      return new BrowseFnError({
        code: 'UPSTREAM_TIMEOUT',
        message: context.provider
          ? `Provider ${context.provider} timed out after configured retries.`
          : 'Upstream provider timed out after configured retries.',
        provider: context.provider,
      });
    }

    if (statusCode === 404 || /HTTP 404/i.test(err.message)) {
      return new BrowseFnError({
        code: 'UPSTREAM_NOT_FOUND',
        message: err.message,
        provider: context.provider,
      });
    }

    if (/^Invalid URL:/i.test(err.message)) {
      return new BrowseFnError({
        code: 'INVALID_URL',
        message: err.message,
        provider: context.provider,
      });
    }

    if (
      /Missing required field|must be a number|Invalid .*parameter|Unsupported cache storage|Cache ttl/i.test(
        err.message
      )
    ) {
      return new BrowseFnError({
        code: 'INVALID_ARGUMENT',
        message: err.message,
        provider: context.provider,
      });
    }

    if (/not available/i.test(err.message)) {
      return new BrowseFnError({
        code: 'PROVIDER_UNAVAILABLE',
        message: err.message,
        provider: context.provider,
      });
    }

    if (/File already exists/i.test(err.message)) {
      return new BrowseFnError({
        code: 'DOWNLOAD_EXISTS',
        message: err.message,
        provider: context.provider,
      });
    }

    return new BrowseFnError({
      code: context.provider ? 'PROVIDER_ERROR' : 'INTERNAL_ERROR',
      message: err.message,
      provider: context.provider,
    });
  }

  private toSerializableError(error: Error): EventData['error'] {
    const candidate = error as Error & { code?: unknown; statusCode?: unknown };
    return {
      name: error.name,
      message: error.message,
      code: typeof candidate.code === 'string' ? candidate.code : undefined,
      statusCode:
        typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined,
    };
  }

  private requireApiKey(
    providerName: string,
    config: ProviderConfig
  ): { apiKey: string; endpoint?: string } {
    if (!config.apiKey) {
      throw new BrowseFnError({
        code: 'INVALID_ARGUMENT',
        message: `Missing required apiKey for provider ${providerName}.`,
        provider: providerName,
      });
    }

    return {
      apiKey: config.apiKey,
      endpoint: config.endpoint,
    };
  }

  private requireUserAgent(
    providerName: string,
    config: ProviderConfig
  ): { endpoint?: string; userAgent: string } {
    if (!config.userAgent) {
      throw new BrowseFnError({
        code: 'INVALID_ARGUMENT',
        message: `Missing required userAgent for provider ${providerName}.`,
        provider: providerName,
      });
    }

    return {
      endpoint: config.endpoint,
      userAgent: config.userAgent,
    };
  }

  private createRequestId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    return `browsefn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export function browseFn(config?: BrowseFnConfig): BrowseFn {
  return new BrowseFn(config);
}
