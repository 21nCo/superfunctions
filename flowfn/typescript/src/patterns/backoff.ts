import { BackoffOptions } from '../queue/types.js';

export function calculateBackoff(attemptsMade: number, options: BackoffOptions): number {
  const { type, delay, maxDelay } = options;

  let resultDelay: number;

  switch (type) {
    case 'fixed':
      resultDelay = delay;
      break;
    case 'exponential':
      resultDelay = delay * Math.pow(2, attemptsMade - 1);
      break;
    case 'custom':
      // Custom should probably be a function passed in opts, 
      // but for serialization we might need a registry.
      // Default to fixed for now if not handled.
      resultDelay = delay;
      break;
    default:
      resultDelay = delay;
  }

  if (maxDelay && resultDelay > maxDelay) {
    return maxDelay;
  }

  return resultDelay;
}
