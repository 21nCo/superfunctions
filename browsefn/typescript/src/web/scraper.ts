/**
 * Web scraper interface
 */

import type {
  WebProvider,
  GetPageOptions,
  PageResult,
  MetadataOptions,
  MetadataResult,
  PageMetadata
} from '../core/types.js';
import { ProviderManager } from '../core/provider-manager.js';
import { CacheManager } from '../core/cache-manager.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { validateGetPageOptions, sanitizeUrl } from '../utils/validation.js';

export class WebScraper {
  private providerManager: ProviderManager<WebProvider>;

  constructor(
    private cache?: CacheManager,
    private rateLimiter?: RateLimiter,
    defaultProvider?: string,
    fallbackChain?: string[]
  ) {
    this.providerManager = new ProviderManager(defaultProvider, fallbackChain);
  }

  /**
   * Register a web provider
   */
  registerProvider(provider: WebProvider): void {
    this.providerManager.register(provider.name, provider);
  }

  /**
   * Get page content
   */
  async getPage(url: string, options: GetPageOptions = {}): Promise<PageResult> {
    const sanitizedUrl = sanitizeUrl(url);
    validateGetPageOptions(options);

    // Check cache
    const cacheEnabled = typeof options.cache === 'boolean' ? options.cache : options.cache?.ttl ? true : this.cache?.config.enabled;
    if (cacheEnabled && this.cache) {
      const cached = await this.cache.get<PageResult>('getPage', sanitizedUrl, options);
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

        // Get page
        return await provider.getPage(sanitizedUrl, options);
      }
    );

    // Cache result
    if (cacheEnabled && this.cache) {
      await this.cache.set('getPage', sanitizedUrl, result, options);
    }

    return result;
  }

  /**
   * Get metadata from multiple URLs
   */
  async getMultipleMetadata(
    urls: string[],
    options: MetadataOptions = {}
  ): Promise<MetadataResult[]> {
    const results: MetadataResult[] = [];
    const concurrency = options.concurrency || 5;
    let completed = 0;

    // Process URLs in batches
    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      const batchPromises = batch.map(async (url): Promise<MetadataResult> => {
        try {
          const startTime = Date.now();
          const page = await this.getPage(url, {
            format: 'html',
            timeout: options.timeout,
            cache: options.cache
          });

          // Filter metadata fields if specified
          let metadata = page.metadata;
          if (options.fields) {
            const filtered: Partial<PageMetadata> = { url: metadata.url };
            options.fields.forEach(field => {
              if (metadata[field]) {
                (filtered as any)[field] = metadata[field];
              }
            });
            metadata = filtered as PageMetadata;
          }

          completed++;
          if (options.onProgress) {
            options.onProgress(completed, urls.length);
          }

          return {
            success: true,
            data: metadata,
            duration: Date.now() - startTime,
            provider: page.provider,
            cached: page.cached
          };
        } catch (error) {
          completed++;
          if (options.onProgress) {
            options.onProgress(completed, urls.length);
          }

          return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Custom scraping with script
   */
  async scrape<T>(
    url: string,
    options: GetPageOptions & { script?: (page: any) => Promise<T> }
  ): Promise<T> {
    const sanitizedUrl = sanitizeUrl(url);
    const provider = this.providerManager.get(options.provider || 'puppeteer');

    if (!provider) {
      throw new Error(`Provider not found: ${options.provider || 'puppeteer'}`);
    }

    // This is a simplified implementation
    // In a real implementation, you'd need to handle the script execution differently per provider
    throw new Error('Custom scraping not yet implemented');
  }

  /**
   * List available providers
   */
  async listProviders(): Promise<string[]> {
    return await this.providerManager.listAvailable();
  }
}
