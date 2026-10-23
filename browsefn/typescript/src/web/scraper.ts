import { mergeSecurity, normalizeSecurity, requiresProtectedTransport } from '../utils/destination-policy.js';
import type { DestinationSecurity } from '../core/types.js';
import { PlaywrightProvider } from './providers/playwright.js';
import { PuppeteerProvider } from './providers/puppeteer.js';
/**
 * Web scraper interface.
 */

import { CheerioProvider } from './providers/cheerio.js';
import { denied } from '../utils/destination-policy.js';
import { BrowseFnError, isBrowseFnError, getUpstreamStatus } from '../core/errors.js';
import type {
  GetPageOptions,
  MetadataOptions,
  MetadataResult,
  PageMetadata,
  PageResult,
  WebProvider,
} from '../core/types.js';
import { RetryMiddleware } from '../middleware/retry.js';
import { CacheManager } from '../core/cache-manager.js';
import { ProviderManager } from '../core/provider-manager.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { sanitizeUrl, validateGetPageOptions } from '../utils/validation.js';

interface ServiceHooks {
  onProviderFallback?: (input: { from: string; to: string; error: Error }) => void;
}

const DEFAULT_METADATA_BATCH_LIMIT = 50;

export class WebScraper {
  private userAgentIndex = 0;
  private providerManager: ProviderManager<WebProvider>;

  constructor(
    private cache?: CacheManager,
    private rateLimiter?: RateLimiter,
    defaultProvider?: string,
    fallbackChain?: string[],
    private hooks?: ServiceHooks,
    private fallbackOnErrors?: string[],
    private userAgents: string[] = [],
    private security?: DestinationSecurity
  ) {
    if (userAgents.some(value => !value.trim() || /[\r\n]/.test(value))) throw new BrowseFnError({ code: 'INVALID_ARGUMENT', message: 'userAgents must contain non-empty valid header values.' });
    this.security = normalizeSecurity(security);
    this.providerManager = new ProviderManager(defaultProvider, fallbackChain);
  }

  registerProvider(provider: WebProvider): void {
    this.providerManager.register(provider.name, provider);
  }

  private withUserAgent(options: GetPageOptions): GetPageOptions {
    if (!this.userAgents.length || Object.keys(options.headers ?? {}).some(key => key.toLowerCase() === 'user-agent')) return options;
    const value = this.userAgents[this.userAgentIndex++ % this.userAgents.length];
    return { ...options, headers: { ...options.headers, 'User-Agent': value } };
  }

  async getPage(url: string, options: GetPageOptions = {}): Promise<PageResult> {
    options = this.withUserAgent({ ...options, security: mergeSecurity(this.security, options.security) });
    const sanitizedUrl = sanitizeUrl(url);
    validateGetPageOptions(options);

    const cacheEnabled = this.isCacheEnabled(options);
    if (cacheEnabled && this.cache) {
      const cached = await this.cache.get<PageResult>('getPage', sanitizedUrl, options);
      if (cached) {
        return { ...cached, cached: true };
      }
    }

    const execute = () => this.executeWithProviderFallback(
      sanitizedUrl,
      options,
      async (provider) => provider.getPage(sanitizedUrl, options)
    );

    const result = options.retry
      ? await new RetryMiddleware({ enabled: true, maxAttempts: options.retry.count + 1, delay: options.retry.delay, backoff: 'linear' }).execute(execute)
      : await execute();

    if (cacheEnabled && this.cache) {
      await this.cache.set('getPage', sanitizedUrl, result, options);
    }

    return result;
  }

  async getMultipleMetadata(
    urls: string[],
    options: MetadataOptions = {}
  ): Promise<MetadataResult[]> {
    options = { ...options, security: mergeSecurity(this.security, options.security) };
    const maxBatchSize = options.maxBatchOverride ?? DEFAULT_METADATA_BATCH_LIMIT;
    if (urls.length > maxBatchSize) {
      throw new BrowseFnError({
        code: 'INVALID_ARGUMENT',
        message: 'Metadata batch size exceeds the configured maximum.',
      });
    }

    const concurrency = Math.max(1, options.concurrency ?? 5);
    const results = new Array<MetadataResult>(urls.length);
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
          const startTime = Date.now();
          const page = await this.getPage(url, {
            format: 'html',
            timeout: options.timeout,
            cache: options.cache,
            security: options.security,
          });

          const metadata = this.filterMetadata(page.metadata, options.fields);
          results[currentIndex] = {
            success: true,
            data: metadata,
            duration: Date.now() - startTime,
            provider: page.provider,
            cached: page.cached,
          };
        } catch (error) {
          const normalizedError = this.normalizeError(error);
          results[currentIndex] = {
            success: false,
            error: normalizedError.message,
          };
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

  async scrape<T>(
    url: string,
    options: GetPageOptions & { script?: (page: unknown) => Promise<T> | T }
  ): Promise<T> {
    options = { ...options, ...this.withUserAgent(options), security: mergeSecurity(this.security, options.security) };
    const sanitizedUrl = sanitizeUrl(url);
    const script = options.script;
    if (!script) {
      throw new BrowseFnError({
        code: 'INVALID_ARGUMENT',
        message: 'Missing required field: script',
      });
    }

    const requestedProvider = options.provider;
    if (requestedProvider && !this.providerManager.get(requestedProvider)) {
      throw new BrowseFnError({
        code: 'UNSUPPORTED_PROVIDER',
        message: `Provider ${requestedProvider} is not registered.`,
        provider: requestedProvider,
      });
    }

    const chain = this.providerManager.getFallbackChain(requestedProvider);
    const errors: BrowseFnError[] = [];

    for (let index = 0; index < chain.length; index += 1) {
      const providerName = chain[index];
      const provider = this.providerManager.get(providerName);
      if (!provider) {
        continue;
      }

      if (requiresProtectedTransport(options.security) && !supportsProtectedDestinations(provider)) throw denied();

      const capabilityError = this.getCustomScrapeCapabilityError(providerName, provider);
      if (capabilityError) {
        errors.push(capabilityError);
        this.emitFallbackIfNeeded(chain, index, capabilityError);
        continue;
      }

      if (!(await this.providerManager.isAvailable(providerName))) {
        const unavailableError = new BrowseFnError({
          code: 'PROVIDER_UNAVAILABLE',
          message: `Provider ${providerName} is not available.`,
          provider: providerName,
        });
        errors.push(unavailableError);
        this.emitFallbackIfNeeded(chain, index, unavailableError);
        continue;
      }

      try {
        await this.rateLimiter?.waitForLimit(providerName);
        return await provider.scrape!(sanitizedUrl, { ...options, script });
      } catch (error) {
        const normalizedError = this.normalizeError(error, providerName);
        if (normalizedError.code === 'SECURITY_POLICY_BLOCKED') throw normalizedError;
        errors.push(normalizedError);
        this.emitFallbackIfNeeded(chain, index, normalizedError);
      }
    }

    throw this.selectTerminalError(errors, requestedProvider);
  }

  async listProviders(): Promise<string[]> {
    return this.providerManager.listAvailable();
  }

  private async executeWithProviderFallback<TResult>(
    url: string,
    options: GetPageOptions,
    execute: (provider: WebProvider, providerName: string) => Promise<TResult>
  ): Promise<TResult> {
    const requestedProvider = options.provider;
    if (requestedProvider && !this.providerManager.get(requestedProvider)) {
      throw new BrowseFnError({
        code: 'UNSUPPORTED_PROVIDER',
        message: `Provider ${requestedProvider} is not registered.`,
        provider: requestedProvider,
      });
    }

    const chain = this.providerManager.getFallbackChain(requestedProvider);
    const errors: BrowseFnError[] = [];
    let fallbackFrom: string | undefined;

    for (let index = 0; index < chain.length; index += 1) {
      const providerName = chain[index];
      const provider = this.providerManager.get(providerName);
      if (!provider) {
        continue;
      }

      if (requiresProtectedTransport(options.security) && !supportsProtectedDestinations(provider)) throw denied();

      const capabilityError = this.getCapabilityError(providerName, provider, options);
      if (capabilityError) {
        errors.push(capabilityError);
        fallbackFrom ??= providerName;
        this.emitFallbackIfNeeded(chain, index, capabilityError);
        continue;
      }

      if (!(await this.providerManager.isAvailable(providerName))) {
        const unavailableError = new BrowseFnError({
          code: 'PROVIDER_UNAVAILABLE',
          message: `Provider ${providerName} is not available.`,
          provider: providerName,
        });
        errors.push(unavailableError);
        fallbackFrom ??= providerName;
        this.emitFallbackIfNeeded(chain, index, unavailableError);
        continue;
      }

      try {
        await this.rateLimiter?.waitForLimit(providerName);
        const result = await execute(provider, providerName);
        return this.annotateResult(result, providerName, fallbackFrom);
      } catch (error) {
        const normalizedError = this.normalizeError(error, providerName);
        if (normalizedError.code === 'SECURITY_POLICY_BLOCKED') throw normalizedError;
        errors.push(normalizedError);
        fallbackFrom ??= providerName;
        this.emitFallbackIfNeeded(chain, index, normalizedError);
      }
    }

    throw this.selectTerminalError(errors, requestedProvider);
  }

  private emitFallbackIfNeeded(
    chain: string[],
    index: number,
    error: Error
  ): void {
    const aliases: Record<string, string> = { RATE_LIMIT: 'RATE_LIMITED', TIMEOUT: 'UPSTREAM_TIMEOUT', NOT_FOUND: 'UPSTREAM_NOT_FOUND' };
    if (this.fallbackOnErrors && !this.fallbackOnErrors.some(code => (aliases[code] ?? code) === (error as BrowseFnError).code)) throw error;
    if (index < chain.length - 1) {
      this.hooks?.onProviderFallback?.({
        from: chain[index],
        to: chain[index + 1],
        error,
      });
    }
  }

  private annotateResult<TResult>(
    result: TResult,
    providerName: string,
    fallbackFrom?: string
  ): TResult {
    if (result && typeof result === 'object') {
      const record = result as Record<string, unknown>;
      if (!('provider' in record) || typeof record.provider !== 'string') {
        record.provider = providerName;
      }
      Object.defineProperty(record, '__browseFnFallbackFrom', {
        value: fallbackFrom !== providerName ? fallbackFrom : undefined,
        enumerable: false,
        configurable: true,
      });
    }

    return result;
  }

  private getCapabilityError(
    providerName: string,
    provider: WebProvider,
    options: GetPageOptions
  ): BrowseFnError | null {
    const missingCapabilities: string[] = [];
    const capabilities = provider.capabilities;

    if (options.javascript === true && !capabilities.javascript) {
      missingCapabilities.push('javascript');
    }
    if (options.screenshot && !capabilities.screenshots) {
      missingCapabilities.push('screenshot');
    }
    if (options.cookies?.length && !capabilities.cookies) {
      missingCapabilities.push('cookies');
    }
    if (options.headers && Object.keys(options.headers).length > 0 && !capabilities.headers) {
      missingCapabilities.push('headers');
    }
    if (options.selectors && !capabilities.selectors) {
      missingCapabilities.push('selectors');
    }
    if (options.proxy && !capabilities.proxy) {
      missingCapabilities.push('proxy');
    }
    if (options.format && !capabilities.formats.includes(options.format)) {
      missingCapabilities.push(`${options.format} format`);
    }

    if (missingCapabilities.length === 0) {
      return null;
    }

    return new BrowseFnError({
      code: 'UNSUPPORTED_PROVIDER_CAPABILITY',
      message: `Provider ${providerName} cannot satisfy ${this.joinRequirements(
        missingCapabilities
      )} requirements.`,
      provider: providerName,
      details: {
        missingCapabilities,
      },
    });
  }

  private getCustomScrapeCapabilityError(
    providerName: string,
    provider: WebProvider
  ): BrowseFnError | null {
    if (provider.capabilities.scriptExecution && provider.scrape) {
      return null;
    }

    return new BrowseFnError({
      code: 'UNSUPPORTED_PROVIDER_CAPABILITY',
      message: `Provider ${providerName} cannot execute custom scrape scripts.`,
      provider: providerName,
    });
  }

  private joinRequirements(requirements: string[]): string {
    if (requirements.length === 1) {
      return requirements[0];
    }
    if (requirements.length === 2) {
      return `${requirements[0]} or ${requirements[1]}`;
    }
    return `${requirements.slice(0, -1).join(', ')}, or ${requirements.at(-1)}`;
  }

  private filterMetadata(
    metadata: PageMetadata,
    fields: MetadataOptions['fields']
  ): PageMetadata {
    if (!fields || fields.length === 0) {
      return metadata;
    }

    const filtered: Partial<PageMetadata> = { url: metadata.url };
    for (const field of fields) {
      const value = metadata[field];
      if (value !== undefined) {
        filtered[field] = value as never;
      }
    }

    return filtered as PageMetadata;
  }

  private selectTerminalError(
    errors: BrowseFnError[],
    requestedProvider?: string
  ): BrowseFnError {
    if (errors.length === 0) {
      return new BrowseFnError({
        code: requestedProvider ? 'UNSUPPORTED_PROVIDER' : 'INTERNAL_ERROR',
        message: requestedProvider
          ? `Provider ${requestedProvider} is not registered.`
          : 'No web providers are registered.',
        provider: requestedProvider,
      });
    }

    const priority = [
      'UNSUPPORTED_PROVIDER_CAPABILITY',
      'UPSTREAM_TIMEOUT',
      'RATE_LIMITED',
      'PROVIDER_UNAVAILABLE',
      'PROVIDER_ERROR',
    ] as const;

    for (const code of priority) {
      const match = errors.find((error) => error.code === code);
      if (match) {
        return match;
      }
    }

    return errors[errors.length - 1];
  }

  private normalizeError(error: unknown, providerName?: string): BrowseFnError {
    if (isBrowseFnError(error)) {
      return error;
    }

    const err = error instanceof Error ? error : new Error(String(error));

    const statusCode = getUpstreamStatus(err);
    if (/timed out|timeout/i.test(err.message) || statusCode === 408 || statusCode === 504) {
      return new BrowseFnError({
        code: 'UPSTREAM_TIMEOUT',
        details: statusCode ? { statusCode } : undefined,
        message: providerName
          ? `Provider ${providerName} timed out after configured retries.`
          : err.message,
        provider: providerName,
      });
    }

    return new BrowseFnError({
      code: statusCode === 429 ? 'RATE_LIMITED' : statusCode === 404 ? 'UPSTREAM_NOT_FOUND' : providerName ? 'PROVIDER_ERROR' : 'INTERNAL_ERROR',
      details: statusCode ? { statusCode } : undefined,
      message: err.message,
      provider: providerName,
    });
  }

  private isCacheEnabled(options: GetPageOptions): boolean {
    if (typeof options.cache === 'boolean') {
      return options.cache;
    }

    if (typeof options.cache === 'object') {
      return true;
    }

    return this.cache?.isEnabled() === true;
  }
}

/** Only built-in transports enforce the router boundary; caller capabilities cannot opt in. */
function supportsProtectedDestinations(provider: WebProvider): boolean {
  if (provider.constructor === CheerioProvider) return true;
  if (provider.constructor === PlaywrightProvider || provider.constructor === PuppeteerProvider) {
    return (provider as PlaywrightProvider | PuppeteerProvider).supportsProtectedDestinations();
  }
  return false;
}
