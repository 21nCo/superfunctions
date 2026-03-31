import type { RetryOptions } from './types.js';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;

export interface ResolvedRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export function resolveRetryOptions(options?: RetryOptions): ResolvedRetryOptions {
  return {
    maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
  };
}

export function computeDelay(attempt: number, options: ResolvedRetryOptions): number {
  const exponentialDelay = options.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * options.baseDelayMs * 0.5;
  return Math.min(exponentialDelay + jitter, options.maxDelayMs);
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return false;
    if ('status' in error) {
      const status = (error as { status: number }).status;
      return status >= 500 || status === 429 || status === 408;
    }
    if (error.message.includes('network') || error.message.includes('fetch')) {
      return true;
    }
  }
  return true;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: ResolvedRetryOptions,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error)) {
        throw error;
      }

      if (attempt < options.maxRetries) {
        const delay = computeDelay(attempt, options);
        await sleep(delay, signal);
      }
    }
  }

  throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timeoutId = setTimeout(resolve, ms);

    signal?.addEventListener('abort', () => {
      clearTimeout(timeoutId);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
