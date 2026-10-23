import { mergeSecurity, normalizeSecurity, requiresProtectedTransport } from '../utils/destination-policy.js';
import type { DestinationSecurity } from '../core/types.js';
/**
 * Image browsing and search interface.
 */

import { basename, extname, resolve, sep } from 'node:path';
import { stat } from 'node:fs/promises';
import { fetchImageBytes, writeImage } from './download.js';
import { transformImage } from './transform.js';
import { ImageSelection } from './selection.js';

import { BrowseFnError } from '../core/errors.js';
import type {
  DownloadResult,
  ImageDownloadOptions,
  ImageProvider,
  ImageResult,
  ImageSearchOptions,
  ImageSearchResult,
} from '../core/types.js';
import { CacheManager } from '../core/cache-manager.js';
import { ProviderManager } from '../core/provider-manager.js';
import { RateLimiter } from '../core/rate-limiter.js';
import {
  sanitizeUrl,
  validateImageDownloadOptions,
  validateImageSearchOptions,
} from '../utils/validation.js';

interface ServiceHooks {
  onProviderFallback?: (input: { from: string; to: string; error: Error }) => void;
}


export class ImageBrowser {
  private selection = new ImageSelection();
  private providerManager: ProviderManager<ImageProvider>;

  constructor(
    private cache?: CacheManager,
    private rateLimiter?: RateLimiter,
    defaultProvider?: string,
    fallbackChain: string[] = [],
    private hooks?: ServiceHooks,
    private security?: DestinationSecurity
  ) {
    this.security = normalizeSecurity(security);
    this.providerManager = new ProviderManager(defaultProvider, fallbackChain);
  }

  registerProvider(provider: ImageProvider): void {
    this.providerManager.register(provider.name, provider);
  }

  async search(
    query: string,
    options: ImageSearchOptions = {}
  ): Promise<ImageSearchResult> {
    validateImageSearchOptions(options);
    let fallbackFrom: string | undefined;

    if (options.cache && this.cache) {
      const cached = await this.cache.get<ImageSearchResult>('imageSearch', query, options);
      if (cached) {
        this.selection.remember(cached.results);
        return cached;
      }
    }

    const result = await this.providerManager.executeWithFallback(
      options.provider,
      async (provider, providerName) => {
        await this.rateLimiter?.waitForLimit(providerName);
        const providerResult = await provider.search(query, options);
        return this.normalizeSearchResult(providerName, providerResult);
      },
      (from, to, error) => {
        fallbackFrom ??= from;
        this.hooks?.onProviderFallback?.({ from, to, error });
      }
    );

    if (options.cache && this.cache) {
      await this.cache.set('imageSearch', query, result, options);
    }

    if (result && typeof result === 'object') {
      Object.defineProperty(result, '__browseFnFallbackFrom', {
        value: fallbackFrom,
        enumerable: false,
        configurable: true,
      });
    }

    this.selection.remember(result.results);
    return result;
  }

  async download(
    input: string | ImageResult,
    options: ImageDownloadOptions = {}
  ): Promise<DownloadResult> {
    options = { ...options, security: mergeSecurity(this.security, options.security ?? (options.allowPrivateHosts === undefined ? undefined : { allowPrivateHosts: options.allowPrivateHosts })) };
    validateImageDownloadOptions(options);
    const providerOptions = options;
    const selection = this.selection.resolve(input, options);
    options = selection.options;
    const sanitizedUrl = sanitizeUrl(selection.url);
    const destinationPath = options.destination
      ? await this.resolveDestinationPath(sanitizedUrl, options)
      : undefined;

    const provider = this.providerManager.getDefault();
    if (provider?.download && requiresProtectedTransport(options.security)) {
      throw new BrowseFnError({ code: 'SECURITY_POLICY_BLOCKED', message: 'Provider cannot enforce the active destination policy.' });
    }
    if (provider?.download) {
      await this.rateLimiter?.waitForLimit(provider.name);
      const result = await provider.download(sanitizedUrl, providerOptions);
      if (result.success && options.destination && !result.path) {
        throw new BrowseFnError({
          code: 'INTERNAL_ERROR',
          message: 'Provider download reported success without a file path.',
          provider: provider.name,
        });
      }
      return result;
    }

    return this.directDownload(sanitizedUrl, options, destinationPath);
  }

  async downloadBatch(
    urls: string[],
    options: ImageDownloadOptions & {
      concurrency?: number;
      onProgress?: (completed: number, total: number) => void;
      onError?: (url: string, error: Error) => void;
    } = {}
  ): Promise<DownloadResult[]> {
    const concurrency = Math.max(1, options.concurrency || 3);
    const results = new Array<DownloadResult>(urls.length);
    let nextIndex = 0;
    let completed = 0;

    const runWorker = async (): Promise<void> => {
      for (;;) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= urls.length) {
          return;
        }

        const url = urls[currentIndex];
        try {
          const downloadOptions = {
            ...options,
            onProgress: undefined,
          };
          results[currentIndex] = await this.download(url, downloadOptions);
        } catch (error) {
          const normalizedError =
            error instanceof Error ? error : new Error(String(error));
          results[currentIndex] = {
            success: false,
            error: normalizedError.message,
          };
          options.onError?.(url, normalizedError);
        } finally {
          completed += 1;
          options.onProgress?.(completed, urls.length);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, urls.length || 1) }, () => runWorker())
    );

    return results;
  }

  async listProviders(): Promise<string[]> {
    return this.providerManager.listAvailable();
  }

  private normalizeSearchResult(
    providerName: string,
    result: ImageSearchResult
  ): ImageSearchResult {
    return {
      query: result.query,
      total: result.total,
      page: result.page,
      perPage: result.perPage,
      nextPage: result.nextPage,
      provider: providerName,
      results: result.results.map((image) => this.normalizeImageResult(providerName, image)),
    };
  }

  private normalizeImageResult(providerName: string, image: ImageResult): ImageResult {
    return {
      ...image,
      source: {
        ...image.source,
        provider: providerName,
      },
    };
  }

  private async directDownload(
    url: string,
    options: ImageDownloadOptions,
    destinationPath?: string
  ): Promise<DownloadResult> {
    const startTime = Date.now();
    const input = await fetchImageBytes(url, options);
    const { bytes, metadata } = await transformImage(input, options);

    const result: DownloadResult = {
      success: true,
      size: bytes.length,
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      duration: Date.now() - startTime,
      metadata: options.metadata ? metadata : undefined,
    };

    if (options.destination && destinationPath) {
      await writeImage(destinationPath, bytes, options.overwrite);
      result.path = destinationPath;
    }

    return result;
  }

  private async resolveDestinationPath(
    url: string,
    options: ImageDownloadOptions
  ): Promise<string> {
    const destinationRoot = resolve(options.destination!);
    let requestedName = options.filename || basename(new URL(url).pathname) || 'download';
    if (!options.filename && options.format) requestedName = requestedName.slice(0, requestedName.length - extname(requestedName).length) + '.' + options.format;

    if (
      requestedName.includes('..') ||
      requestedName.includes('/') ||
      requestedName.includes('\\')
    ) {
      throw new BrowseFnError({
        code: 'SECURITY_POLICY_BLOCKED',
        message: 'Download path escapes the destination root.',
      });
    }

    const candidatePath = resolve(destinationRoot, requestedName);
    if (
      candidatePath !== destinationRoot &&
      !candidatePath.startsWith(`${destinationRoot}${sep}`)
    ) {
      throw new BrowseFnError({
        code: 'SECURITY_POLICY_BLOCKED',
        message: 'Download path escapes the destination root.',
      });
    }

    if (options.overwrite === false) {
      try {
        await stat(candidatePath);
        throw new BrowseFnError({
          code: 'DOWNLOAD_EXISTS',
          message: 'Destination file already exists and overwrite is disabled.',
        });
      } catch (error) {
        if (error instanceof BrowseFnError) {
          throw error;
        }
      }
    }

    return candidatePath;
  }

}
