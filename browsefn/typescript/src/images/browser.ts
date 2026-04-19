/**
 * Image browsing and search interface.
 */

import { Buffer } from 'node:buffer';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { mkdir, stat, writeFile } from 'node:fs/promises';

import { BrowseFnError } from '../core/errors.js';
import type {
  DownloadResult,
  ImageDownloadOptions,
  ImageMetadata,
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

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;

export class ImageBrowser {
  private providerManager: ProviderManager<ImageProvider>;

  constructor(
    private cache?: CacheManager,
    private rateLimiter?: RateLimiter,
    defaultProvider?: string,
    fallbackChain: string[] = [],
    private hooks?: ServiceHooks
  ) {
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

    return result;
  }

  async download(
    url: string,
    options: ImageDownloadOptions = {}
  ): Promise<DownloadResult> {
    validateImageDownloadOptions(options);
    const sanitizedUrl = sanitizeUrl(url);
    const destinationPath = options.destination
      ? await this.resolveDestinationPath(sanitizedUrl, options)
      : undefined;

    const provider = this.providerManager.getDefault();
    if (provider?.download) {
      await this.rateLimiter?.waitForLimit(provider.name);
      const result = await provider.download(sanitizedUrl, options);
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
    const bytes = await this.fetchImageBytes(url, options);
    const metadata = this.extractMetadata(bytes, options.format ?? this.detectFormat(url, bytes));

    const hasTransformOptions =
      options.format !== undefined ||
      options.quality !== undefined ||
      options.maxWidth !== undefined ||
      options.maxHeight !== undefined ||
      options.crop !== undefined ||
      options.watermark !== undefined;
    if (hasTransformOptions) {
      throw new BrowseFnError({
        code: 'INVALID_ARGUMENT',
        message: 'Image transforms are not supported in the TypeScript runtime yet.',
      });
    }

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
      await mkdir(resolve(options.destination), { recursive: true });
      await writeFile(destinationPath, bytes);
      result.path = destinationPath;
    }

    return result;
  }

  private async fetchImageBytes(
    inputUrl: string,
    options: ImageDownloadOptions
  ): Promise<Uint8Array> {
    let currentUrl = inputUrl;
    let redirectsRemaining = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;

    for (;;) {
      this.ensureAllowedTarget(currentUrl, options);
      const response = await fetch(currentUrl, { redirect: 'manual' });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirectsRemaining <= 0) {
          throw new BrowseFnError({
            code: 'SECURITY_POLICY_BLOCKED',
            message: 'Redirect limit exceeded for image download.',
          });
        }

        const location = response.headers.get('location');
        if (!location) {
          throw new BrowseFnError({
            code: 'PROVIDER_ERROR',
            message: 'Redirect response did not include a location header.',
          });
        }

        currentUrl = new URL(location, currentUrl).toString();
        redirectsRemaining -= 1;
        continue;
      }

      if (!response.ok) {
        throw new BrowseFnError({
          code: response.status === 404 ? 'UPSTREAM_NOT_FOUND' : 'PROVIDER_ERROR',
          message: `HTTP ${response.status}: ${response.statusText}`,
        });
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && Number(contentLength) > maxPayloadBytes) {
        throw new BrowseFnError({
          code: 'DOWNLOAD_TOO_LARGE',
          message: 'Image payload exceeds the configured maximum size.',
        });
      }

      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      if (bytes.length > maxPayloadBytes) {
        throw new BrowseFnError({
          code: 'DOWNLOAD_TOO_LARGE',
          message: 'Image payload exceeds the configured maximum size.',
        });
      }

      options.onProgress?.(bytes.length, bytes.length);
      return bytes;
    }
  }

  private ensureAllowedTarget(url: string, options: ImageDownloadOptions): void {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (options.allowPrivateHosts) {
      return;
    }

    const isLoopback =
      host === 'localhost' ||
      host === '::1' ||
      host === '[::1]' ||
      host.startsWith('127.');
    const isPrivateIpv4 =
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);

    if (isLoopback || isPrivateIpv4) {
      throw new BrowseFnError({
        code: 'SECURITY_POLICY_BLOCKED',
        message: 'Target host is not allowed by the active security policy.',
      });
    }
  }

  private async resolveDestinationPath(
    url: string,
    options: ImageDownloadOptions
  ): Promise<string> {
    const destinationRoot = resolve(options.destination!);
    const requestedName = options.filename || basename(new URL(url).pathname) || 'download';

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

  private extractMetadata(bytes: Uint8Array, formatHint?: string): ImageMetadata {
    const format = this.detectFormat(undefined, bytes, formatHint);
    if (format === 'png') {
      return this.extractPngMetadata(bytes);
    }
    if (format === 'jpeg') {
      return this.extractJpegMetadata(bytes);
    }
    if (format === 'webp') {
      return this.extractWebpMetadata(bytes);
    }

    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: 'Unsupported image format.',
    });
  }

  private detectFormat(
    url?: string,
    bytes?: Uint8Array,
    preferredFormat?: string
  ): 'jpeg' | 'png' | 'webp' {
    if (preferredFormat === 'jpeg' || preferredFormat === 'png' || preferredFormat === 'webp') {
      return preferredFormat;
    }

    if (bytes && bytes.length >= 12) {
      if (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
      ) {
        return 'png';
      }
      if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        return 'jpeg';
      }
      if (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      ) {
        return 'webp';
      }
    }

    const extension = url ? extname(url).toLowerCase() : '';
    if (extension === '.jpg' || extension === '.jpeg') {
      return 'jpeg';
    }
    if (extension === '.png') {
      return 'png';
    }
    if (extension === '.webp') {
      return 'webp';
    }

    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: 'Unable to determine image format.',
    });
  }

  private extractPngMetadata(bytes: Uint8Array): ImageMetadata {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      format: 'png',
      width: view.getUint32(16),
      height: view.getUint32(20),
      size: bytes.length,
      hasAlpha: true,
    };
  }

  private extractJpegMetadata(bytes: Uint8Array): ImageMetadata {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = bytes[offset + 1];
      const blockLength = (bytes[offset + 2] << 8) + bytes[offset + 3];
      if (marker >= 0xc0 && marker <= 0xc3) {
        const height = (bytes[offset + 5] << 8) + bytes[offset + 6];
        const width = (bytes[offset + 7] << 8) + bytes[offset + 8];
        return {
          format: 'jpeg',
          width,
          height,
          size: bytes.length,
          hasAlpha: false,
        };
      }
      offset += 2 + blockLength;
    }

    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: 'Unable to read JPEG metadata.',
    });
  }

  private extractWebpMetadata(bytes: Uint8Array): ImageMetadata {
    const kind = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (kind === 'VP8 ') {
      const width = bytes[26] | (bytes[27] << 8);
      const height = bytes[28] | (bytes[29] << 8);
      return {
        format: 'webp',
        width,
        height,
        size: bytes.length,
      };
    }

    if (kind === 'VP8L') {
      const bits =
        bytes[21] |
        (bytes[22] << 8) |
        (bytes[23] << 16) |
        (bytes[24] << 24);
      return {
        format: 'webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
        size: bytes.length,
        hasAlpha: true,
      };
    }

    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: 'Unable to read WebP metadata.',
    });
  }
}
