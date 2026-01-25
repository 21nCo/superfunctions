import { Job } from '../queue/types.js';

export interface CircuitBreakerOptions {
  threshold: number;
  timeout: number;
  resetTimeout?: number;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export function circuitBreaker<T>(
  options: CircuitBreakerOptions,
  handler: (job: Job<T>) => Promise<any>
) {
  let state: CircuitState = 'CLOSED';
  let failures = 0;
  let lastFailureTime = 0;
  let lastSuccessTime = 0;

  return async (job: Job<T>) => {
    const now = Date.now();

    if (state === 'OPEN') {
      if (now - lastFailureTime > options.timeout) {
        state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit Breaker is OPEN');
      }
    }

    try {
      const result = await handler(job);
      
      if (state === 'HALF_OPEN') {
        state = 'CLOSED';
        failures = 0;
      }
      
      lastSuccessTime = now;
      return result;
    } catch (err) {
      failures++;
      lastFailureTime = now;

      if (state === 'HALF_OPEN' || failures >= options.threshold) {
        state = 'OPEN';
      }

      throw err;
    }
  };
}
