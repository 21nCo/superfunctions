/**
 * Main BrowseFn class
 */

import type {
  BrowseFnConfig,
  BrowseFnEvent,
  EventHandler,
  Metrics,
  RateLimitStatus
} from './types.js';
import { CacheManager } from './cache-manager.js';
import { RateLimiter } from './rate-limiter.js';
import { WebScraper } from '../web/scraper.js';
import { ImageBrowser } from '../images/browser.js';
import { Geocoder } from '../geo/geocoder.js';
import { RetryMiddleware } from '../middleware/retry.js';
import { Logger } from '../middleware/logging.js';
import { MetricsCollector } from '../middleware/metrics.js';

// Import providers
import { CheerioProvider } from '../web/providers/cheerio.js';
import { PuppeteerProvider } from '../web/providers/puppeteer.js';
import { PlaywrightProvider } from '../web/providers/playwright.js';
import { UnsplashProvider } from '../images/providers/unsplash.js';
import { PixabayProvider } from '../images/providers/pixabay.js';
import { PexelsProvider } from '../images/providers/pexels.js';
import { NominatimProvider } from '../geo/providers/nominatim.js';

export class BrowseFn {
  private cacheManager?: CacheManager;
  private rateLimiter?: RateLimiter;
  private retryMiddleware?: RetryMiddleware;
  private logger: Logger;
  private metricsCollector: MetricsCollector;
  private eventHandlers = new Map<BrowseFnEvent, Set<EventHandler>>();

  public web: WebScraper;
  public images: ImageBrowser;
  public geo: Geocoder;
  public cache?: CacheManager;

  constructor(config: BrowseFnConfig = {}) {
    // Initialize cache
    if (config.cache?.enabled) {
      this.cacheManager = new CacheManager(config.cache);
      this.cache = this.cacheManager;
    }

    // Initialize rate limiter
    if (config.rateLimit) {
      this.rateLimiter = new RateLimiter(
        config.rateLimit.global,
        config.rateLimit.perProvider
      );
    }

    // Initialize retry middleware
    if (config.retry?.enabled) {
      this.retryMiddleware = new RetryMiddleware(config.retry);
    }

    // Initialize logger and metrics
    this.logger = new Logger();
    this.metricsCollector = new MetricsCollector();

    // Initialize web scraper
    this.web = new WebScraper(
      this.cacheManager,
      this.rateLimiter,
      config.web?.defaultProvider,
      config.web?.fallbackChain
    );

    // Register web providers
    if (config.web?.providers) {
      if (config.web.providers.cheerio) {
        this.web.registerProvider(new CheerioProvider(config.web.providers.cheerio));
      }
      if (config.web.providers.puppeteer) {
        this.web.registerProvider(new PuppeteerProvider(config.web.providers.puppeteer));
      }
      if (config.web.providers.playwright) {
        this.web.registerProvider(new PlaywrightProvider(config.web.providers.playwright));
      }
    } else {
      // Register default cheerio provider
      this.web.registerProvider(new CheerioProvider());
    }

    // Initialize image browser
    this.images = new ImageBrowser(
      this.cacheManager,
      this.rateLimiter,
      config.images?.defaultProvider
    );

    // Register image providers
    if (config.images?.providers) {
      if (config.images.providers.unsplash) {
        this.images.registerProvider(new UnsplashProvider(config.images.providers.unsplash));
      }
      if (config.images.providers.pixabay) {
        this.images.registerProvider(new PixabayProvider(config.images.providers.pixabay));
      }
      if (config.images.providers.pexels) {
        this.images.registerProvider(new PexelsProvider(config.images.providers.pexels));
      }
    }

    // Initialize geocoder
    this.geo = new Geocoder(
      this.cacheManager,
      this.rateLimiter,
      config.geo?.defaultProvider
    );

    // Register geo providers
    if (config.geo?.providers) {
      if (config.geo.providers.nominatim) {
        this.geo.registerProvider(new NominatimProvider(config.geo.providers.nominatim));
      }
    }
  }

  /**
   * Register event handler
   */
  on(event: BrowseFnEvent, handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Unregister event handler
   */
  off(event: BrowseFnEvent, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Emit event
   */
  private emit(event: BrowseFnEvent, data: any): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => handler(data));
    }
  }

  /**
   * Get metrics
   */
  async getMetrics(options?: {
    timeRange?: 'last-hour' | 'last-24h' | 'last-7d' | 'all';
    groupBy?: 'provider';
  }): Promise<Metrics> {
    const metrics = this.metricsCollector.getMetrics(options);

    // Add cache hit rate if cache is enabled
    if (this.cacheManager) {
      const cacheStats = await this.cacheManager.getStats();
      metrics.cacheHitRate = cacheStats.hitRate;
    }

    return metrics;
  }

  /**
   * Get rate limit status
   */
  getRateLimitStatus(provider: string): RateLimitStatus {
    if (!this.rateLimiter) {
      return { remaining: Infinity, resetAt: 0, limit: Infinity };
    }
    return this.rateLimiter.getStatus(provider);
  }

  /**
   * Get logs
   */
  getLogs(filter?: { provider?: string; since?: number }) {
    return this.logger.getLogs(filter);
  }

  /**
   * Clear cache
   */
  async clearCache(): Promise<void> {
    if (this.cacheManager) {
      await this.cacheManager.clear();
    }
  }

  /**
   * Clear metrics
   */
  clearMetrics(): void {
    this.metricsCollector.clear();
  }

  /**
   * Clear logs
   */
  clearLogs(): void {
    this.logger.clear();
  }
}

/**
 * Factory function for creating BrowseFn instances
 */
export function browseFn(config?: BrowseFnConfig): BrowseFn {
  return new BrowseFn(config);
}
