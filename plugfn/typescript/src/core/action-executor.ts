import type {
  ActionOptions,
  ActionResult,
  ActionContext,
  BatchAction,
  BatchResult,
} from '../types/action.js';
import type { Provider } from '../types/provider.js';
import { AuthType } from '../types/provider.js';
import type { Logger } from '../types/action.js';
import type { Credentials } from '../types/connection.js';
import { ConnectionManager } from './connection-manager.js';
import { ProviderRegistry } from './provider-registry.js';
import { RetryMiddleware } from '../middleware/retry.js';
import { RateLimiter } from '../middleware/rate-limiter.js';
import { CacheMiddleware } from '../middleware/caching.js';
import { LoggingMiddleware } from '../middleware/logging.js';
import { MetricsMiddleware } from '../middleware/metrics.js';
import { FetchHttpClient } from '../utils/request.js';
import { ApiKeyAuthHandler } from '../auth/api-key-auth.js';
import { BasicAuthHandler } from '../auth/basic-auth.js';

/**
 * Action executor handles executing provider actions
 */
export class ActionExecutor {
  private httpClient: FetchHttpClient;
  private retryMiddleware: RetryMiddleware;
  private rateLimiter: RateLimiter;
  private cacheMiddleware: CacheMiddleware;
  private loggingMiddleware: LoggingMiddleware;
  private metricsMiddleware: MetricsMiddleware;

  constructor(
    private connectionManager: ConnectionManager,
    private providerRegistry: ProviderRegistry,
    private logger: Logger,
    _options: {
      enableRetry?: boolean;
      enableRateLimit?: boolean;
      enableCache?: boolean;
      enableLogging?: boolean;
      enableMetrics?: boolean;
    } = {}
  ) {
    this.httpClient = new FetchHttpClient();
    this.retryMiddleware = new RetryMiddleware({}, logger);
    this.rateLimiter = new RateLimiter();
    this.cacheMiddleware = new CacheMiddleware(300000, logger);
    this.loggingMiddleware = new LoggingMiddleware(logger);
    this.metricsMiddleware = new MetricsMiddleware();
  }

  /**
   * Execute an action
   */
  async execute<T>(
    provider: string,
    action: string,
    options: ActionOptions
  ): Promise<ActionResult<T>> {
    const startTime = Date.now();
    let retries = 0;
    let cached = false;

    try {
      // Get provider
      const providerObj = this.providerRegistry.get(provider);
      if (!providerObj) {
        throw new Error(`Provider ${provider} not found`);
      }

      // Get action
      const actionObj = providerObj.actions[action];
      if (!actionObj) {
        throw new Error(`Action ${action} not found in provider ${provider}`);
      }

      // Validate parameters
      const validatedParams = actionObj.parameters.parse(options.params);

      // Generate cache key
      const cacheKey = this.cacheMiddleware.generateKey(
        provider,
        action,
        validatedParams,
        options.userId
      );

      // Check cache
      if (options.cache !== false) {
        const cachedResult = await this.cacheMiddleware.get<T>(cacheKey);
        if (cachedResult !== null) {
          this.logger.debug(`Cache hit for ${provider}.${action}`);
          
          return {
            success: true,
            data: cachedResult,
            provider,
            action,
            cached: true,
            duration: Date.now() - startTime,
            retries: 0,
            timestamp: new Date(),
          };
        }
      }

      // Get or select connection
      const connection = options.connectionId
        ? await this.connectionManager.get(options.connectionId)
        : await this.connectionManager.getByUserAndProvider(options.userId, provider);

      if (!connection) {
        throw new Error(`No connection found for provider ${provider} and user ${options.userId}`);
      }

      // Get credentials
      const credentials = await this.connectionManager.getCredentials(connection.id);

      // Apply rate limiting
      if (providerObj.rateLimit) {
        const rateLimitKey = `${provider}:${options.userId}`;
        await this.rateLimiter.acquire(rateLimitKey, providerObj.rateLimit);
      }

      // Build action context
      const context: ActionContext = {
        userId: options.userId,
        connectionId: connection.id,
        provider: {
          name: providerObj.name,
          baseUrl: providerObj.baseUrl,
        },
        auth: {
          type: providerObj.auth.type,
          credentials,
        },
        http: this.createAuthenticatedHttpClient(providerObj, credentials),
        logger: this.logger,
      };

      // Execute action with retry
      const executeAction = async () => {
        return actionObj.execute(validatedParams, context);
      };

      const result = await this.retryMiddleware.execute(
        executeAction,
        `${provider}.${action}`
      );

      retries = result.retries;
      const data = result.data;

      // Validate response
      const validatedData = actionObj.returns.parse(data);

      // Cache result
      if (options.cache !== false) {
        const ttl = typeof options.cache === 'object' ? options.cache.ttl : undefined;
        await this.cacheMiddleware.set(cacheKey, validatedData, ttl);
      }

      // Mark connection as used
      await this.connectionManager.markUsed(connection.id);

      // Log success
      const duration = Date.now() - startTime;
      this.loggingMiddleware.logActionSuccess(provider, action, duration, cached, options.userId);

      // Record metrics
      this.metricsMiddleware.record({
        provider,
        action,
        userId: options.userId,
        status: 'success',
        duration,
      });

      return {
        success: true,
        data: validatedData,
        provider,
        action,
        cached,
        duration,
        retries,
        timestamp: new Date(),
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const err = error as Error;

      // Log error
      this.loggingMiddleware.logActionError(provider, action, err, duration, retries, options.userId);

      // Record metrics
      this.metricsMiddleware.record({
        provider,
        action,
        userId: options.userId,
        status: 'error',
        duration,
      });

      return {
        success: false,
        error: err,
        provider,
        action,
        duration,
        retries,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Execute multiple actions in batch
   */
  async batch(actions: BatchAction[]): Promise<BatchResult[]> {
    const promises = actions.map((action) =>
      this.execute(action.provider, action.action, {
        userId: action.userId,
        connectionId: action.connectionId,
        params: action.params,
      })
    );

    return Promise.all(promises);
  }

  /**
   * Get metrics
   */
  getMetrics(options: any) {
    return this.metricsMiddleware.getMetrics(options);
  }

  /**
   * Create HTTP client with authentication
   */
  private createAuthenticatedHttpClient(provider: Provider, credentials: Credentials): any {
    const baseHeaders: Record<string, string> = {
      ...provider.headers,
    };

    // Add authentication headers based on auth type
    switch (provider.auth.type) {
      case AuthType.OAuth2:
        if (credentials.type === 'oauth2') {
          baseHeaders.Authorization = `Bearer ${credentials.accessToken}`;
        }
        break;

      case AuthType.ApiKey:
        if (credentials.type === 'api-key' && provider.auth.config) {
          const handler = new ApiKeyAuthHandler(provider.auth.config);
          Object.assign(baseHeaders, handler.addToHeaders({}, credentials));
        }
        break;

      case AuthType.JWT:
        if (credentials.type === 'jwt') {
          baseHeaders.Authorization = `Bearer ${credentials.token}`;
        }
        break;

      case AuthType.Basic:
        if (credentials.type === 'basic') {
          const handler = new BasicAuthHandler();
          Object.assign(baseHeaders, handler.addToHeaders({}, credentials));
        }
        break;
    }

    // Return wrapped HTTP client with auth headers
    return {
      get: (url: string, config?: any) =>
        this.httpClient.get(url, {
          ...config,
          headers: { ...baseHeaders, ...config?.headers },
        }),
      post: (url: string, data?: any, config?: any) =>
        this.httpClient.post(url, data, {
          ...config,
          headers: { ...baseHeaders, ...config?.headers },
        }),
      put: (url: string, data?: any, config?: any) =>
        this.httpClient.put(url, data, {
          ...config,
          headers: { ...baseHeaders, ...config?.headers },
        }),
      patch: (url: string, data?: any, config?: any) =>
        this.httpClient.patch(url, data, {
          ...config,
          headers: { ...baseHeaders, ...config?.headers },
        }),
      delete: (url: string, config?: any) =>
        this.httpClient.delete(url, {
          ...config,
          headers: { ...baseHeaders, ...config?.headers },
        }),
    };
  }
}

