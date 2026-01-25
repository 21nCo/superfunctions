/**
 * Retry middleware
 */

import type { RetryConfig } from '../core/types.js';

export class RetryMiddleware {
  constructor(private config: RetryConfig) {}

  /**
   * Execute with retry logic
   */
  async execute<T>(
    fn: () => Promise<T>,
    context?: { url?: string; provider?: string }
  ): Promise<T> {
    if (!this.config.enabled) {
      return await fn();
    }

    let lastError: Error | null = null;
    const maxAttempts = this.config.maxAttempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Check if error is retryable
        if (this.config.retryOn && error instanceof Error) {
          const errorCode = (error as any).code || (error as any).statusCode;
          if (errorCode && !this.config.retryOn.includes(errorCode)) {
            throw error;
          }
        }

        // Don't retry on last attempt
        if (attempt === maxAttempts) {
          break;
        }

        // Call retry callback
        if (this.config.onRetry) {
          this.config.onRetry(attempt, error as Error);
        }

        // Calculate delay
        const delay = this.calculateDelay(attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError || new Error('Max retry attempts reached');
  }

  /**
   * Calculate delay based on backoff strategy
   */
  private calculateDelay(attempt: number): number {
    const baseDelay = this.config.delay;

    if (this.config.backoff === 'exponential') {
      return baseDelay * Math.pow(2, attempt - 1);
    }

    return baseDelay * attempt;
  }
}
