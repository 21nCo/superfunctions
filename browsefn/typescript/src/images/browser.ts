/**
 * Image browsing and search interface
 */

import type {
  ImageProvider,
  ImageSearchOptions,
  ImageSearchResult,
  ImageDownloadOptions,
  DownloadResult
} from '../core/types.js';
import { ProviderManager } from '../core/provider-manager.js';
import { CacheManager } from '../core/cache-manager.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { validateImageSearchOptions } from '../utils/validation.js';

export class ImageBrowser {
  private providerManager: ProviderManager<ImageProvider>;

  constructor(
    private cache?: CacheManager,
    private rateLimiter?: RateLimiter,
    defaultProvider?: string,
    fallbackChain?: string[] = []
  ) {
    this.providerManager = new ProviderManager(defaultProvider, fallbackChain);
  }

  /**
   * Register an image provider
   */
  registerProvider(provider: ImageProvider): void {
    this.providerManager.register(provider.name, provider);
  }

  /**
   * Search for images
   */
  async search(
    query: string,
    options: ImageSearchOptions = {}
  ): Promise<ImageSearchResult> {
    validateImageSearchOptions(options);

    // Check cache
    if (options.cache && this.cache) {
      const cached = await this.cache.get<ImageSearchResult>('imageSearch', query, options);
      if (cached) {
        return cached;
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

        return await provider.search(query, options);
      }
    );

    // Cache result
    if (options.cache && this.cache) {
      await this.cache.set('imageSearch', query, result, options);
    }

    return result;
  }

  /**
   * Download a single image
   */
  async download(
    url: string,
    options: ImageDownloadOptions = {}
  ): Promise<DownloadResult> {
    // Try to get provider from URL or use default
    const provider = this.providerManager.getDefault();

    if (!provider || !provider.download) {
      // Fallback to direct download
      return this.directDownload(url, options);
    }

    // Check rate limit
    if (this.rateLimiter) {
      await this.rateLimiter.waitForLimit(provider.name);
    }

    return await provider.download(url, options);
  }

  /**
   * Download multiple images
   */
  async downloadBatch(
    urls: string[],
    options: ImageDownloadOptions & {
      concurrency?: number;
      onProgress?: (completed: number, total: number) => void;
      onError?: (url: string, error: Error) => void;
    } = {}
  ): Promise<DownloadResult[]> {
    const results: DownloadResult[] = [];
    const concurrency = options.concurrency || 3;
    let completed = 0;

    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      const batchPromises = batch.map(async (url): Promise<DownloadResult> => {
        try {
          const result = await this.download(url, options);
          completed++;
          if (options.onProgress) {
            options.onProgress(completed, urls.length);
          }
          return result;
        } catch (error) {
          completed++;
          if (options.onProgress) {
            options.onProgress(completed, urls.length);
          }
          if (options.onError) {
            options.onError(url, error as Error);
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
   * Direct download without provider
   */
  private async directDownload(
    url: string,
    options: ImageDownloadOptions
  ): Promise<DownloadResult> {
    const startTime = Date.now();

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // Save to file if destination specified
      if (options.destination) {
        const fs = await import('fs/promises');
        const path = await import('path');
        
        const filename = options.filename || path.basename(new URL(url).pathname);
        const filePath = path.join(options.destination, filename);

        if (!options.overwrite) {
          try {
            await fs.access(filePath);
            throw new Error(`File already exists: ${filePath}`);
          } catch {
            // File doesn't exist, continue
          }
        }

        await fs.writeFile(filePath, bytes);

        return {
          success: true,
          path: filePath,
          size: bytes.length,
          duration: Date.now() - startTime
        };
      }

      return {
        success: true,
        size: bytes.length,
        duration: Date.now() - startTime
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * List available providers
   */
  async listProviders(): Promise<string[]> {
    return await this.providerManager.listAvailable();
  }
}
