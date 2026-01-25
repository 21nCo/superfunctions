import { randomBytes } from 'crypto';

export function generateId(prefix?: string): string {
  const random = randomBytes(16).toString('hex');
  return prefix ? `${prefix}_${random}` : random;
}

export function calculateEntropy(str: string): number {
  if (!str) return 0;
  
  const len = str.length;
  const frequencies: Record<string, number> = {};
  
  for (let i = 0; i < len; i++) {
    const char = str[i];
    frequencies[char] = (frequencies[char] || 0) + 1;
  }
  
  let entropy = 0;
  for (const char in frequencies) {
    const probability = frequencies[char] / len;
    entropy -= probability * Math.log2(probability);
  }
  
  return entropy;
}

export function redactSecret(secret: string, visibleChars = 4): string {
  if (secret.length <= visibleChars) {
    return '*'.repeat(secret.length);
  }
  
  const start = secret.slice(0, visibleChars);
  const rest = '*'.repeat(secret.length - visibleChars);
  return start + rest;
}

export function isExpired(timestamp?: number): boolean {
  if (!timestamp) return false;
  return Date.now() > timestamp;
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function sanitizeForLog(obj: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const sensitiveKeys = ['password', 'secret', 'token', 'key', 'apiKey', 'api_key'];
  
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeForLog(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

export function parseTimeWindow(window: string | number): number {
  if (typeof window === 'number') return window;
  
  const match = window.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) {
    throw new Error(`Invalid time window format: ${window}`);
  }
  
  const [, value, unit] = match;
  const num = parseInt(value, 10);
  
  switch (unit) {
    case 'ms': return num;
    case 's': return num * 1000;
    case 'm': return num * 60 * 1000;
    case 'h': return num * 60 * 60 * 1000;
    case 'd': return num * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown time unit: ${unit}`);
  }
}
