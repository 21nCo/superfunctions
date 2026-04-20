/**
 * Retry middleware.
 */

import { BrowseFnError, isBrowseFnError } from '../core/errors.js';
import type { RetryConfig } from '../core/types.js';

interface RetryExecutionContext {
  operation?: string;
  provider?: string;
  onRetryAttempt?: (input: {
    attempt: number;
    delayMs: number;
    error: Error;
    provider?: string;
    operation?: string;
  }) => void;
}

export class RetryMiddleware {
  constructor(private readonly config: RetryConfig) {}

  async execute<T>(
    fn: () => Promise<T>,
    context: RetryExecutionContext = {}
  ): Promise<T> {
    if (!this.config.enabled) {
      return fn();
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.shouldRetry(lastError) || attempt === this.config.maxAttempts) {
          break;
        }

        const delayMs = this.calculateDelay(attempt, lastError);
        this.config.onRetry?.(attempt, lastError);
        context.onRetryAttempt?.({
          attempt,
          delayMs,
          error: lastError,
          provider: context.provider,
          operation: context.operation,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError ?? new BrowseFnError({
      code: 'INTERNAL_ERROR',
      message: 'Retry execution failed without a captured error.',
      provider: context.provider,
    });
  }

  private shouldRetry(error: Error): boolean {
    if (!this.config.retryOn || this.config.retryOn.length === 0) {
      return true;
    }

    const statusCode = this.getErrorStatusCode(error);
    return statusCode !== undefined && this.config.retryOn.includes(statusCode);
  }

  private getErrorStatusCode(error: Error): number | undefined {
    if (isBrowseFnError(error)) {
      if (error.code === 'RATE_LIMITED') {
        return 429;
      }
      if (error.code === 'UPSTREAM_TIMEOUT') {
        return 504;
      }
      if (error.code === 'UPSTREAM_NOT_FOUND') {
        return 404;
      }
    }

    const candidate = (error as Error & { statusCode?: unknown; status?: unknown; code?: unknown });
    if (typeof candidate.statusCode === 'number') {
      return candidate.statusCode;
    }
    if (typeof candidate.status === 'number') {
      return candidate.status;
    }
    if (typeof candidate.code === 'number') {
      return candidate.code;
    }
    return undefined;
  }

  private calculateDelay(attempt: number, error: Error): number {
    const baseDelay = this.config.delay;
    const retryAfterMs =
      isBrowseFnError(error) && typeof error.retryAfterMs === 'number'
        ? error.retryAfterMs
        : 0;

    const computedDelay =
      this.config.backoff === 'exponential'
        ? baseDelay * Math.pow(2, attempt - 1)
        : baseDelay * attempt;

    return Math.max(retryAfterMs, computedDelay);
  }
}
