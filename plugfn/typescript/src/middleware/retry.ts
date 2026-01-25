import type { RetryOptions } from '../types/action.js';
import type { Logger } from '../types/action.js';

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  delay: 1000,
  backoff: 'exponential',
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};

/**
 * Retry middleware for action execution
 */
export class RetryMiddleware {
  constructor(
    private options: RetryOptions = {},
    private logger?: Logger
  ) {}

  /**
   * Execute a function with retry logic
   */
  async execute<T>(fn: () => Promise<T>, context?: string): Promise<{ data: T; retries: number }> {
    const opts = { ...DEFAULT_RETRY_OPTIONS, ...this.options };
    let lastError: Error | undefined;
    let attempt = 0;

    while (attempt < opts.maxAttempts) {
      try {
        const data = await fn();
        
        if (attempt > 0) {
          this.logger?.info(`${context || 'Action'} succeeded after ${attempt} retries`);
        }
        
        return { data, retries: attempt };
      } catch (error) {
        lastError = error as Error;
        attempt++;

        // Check if error is retryable
        if (!this.isRetryable(error, opts)) {
          this.logger?.warn(`${context || 'Action'} failed with non-retryable error`, { error });
          throw error;
        }

        if (attempt >= opts.maxAttempts) {
          this.logger?.error(
            `${context || 'Action'} failed after ${attempt} attempts`,
            { error: lastError }
          );
          break;
        }

        // Calculate delay with backoff
        const delay = this.calculateDelay(attempt, opts);
        
        this.logger?.warn(
          `${context || 'Action'} failed (attempt ${attempt}/${opts.maxAttempts}), retrying in ${delay}ms`,
          { error: lastError }
        );

        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Check if an error should trigger a retry
   */
  private isRetryable(error: any, options: Required<RetryOptions>): boolean {
    // Network errors are retryable
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return true;
    }

    // Check HTTP status codes
    if (error.status && options.retryableStatusCodes.includes(error.status)) {
      return true;
    }

    return false;
  }

  /**
   * Calculate delay with backoff strategy
   */
  private calculateDelay(attempt: number, options: Required<RetryOptions>): number {
    if (options.backoff === 'exponential') {
      return options.delay * Math.pow(2, attempt - 1);
    }
    
    // Linear backoff
    return options.delay * attempt;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

