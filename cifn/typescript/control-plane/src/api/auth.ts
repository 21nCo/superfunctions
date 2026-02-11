import { Context, Next } from 'hono';
import { error } from './envelope.js';
import type { SecretsAdapter } from '../integrations/types.js';

export const authMiddleware = (secFn: SecretsAdapter, excludedPaths: string[] = []) => {
  return async (c: Context, next: Next) => {
    // Check if path is excluded
    if (excludedPaths.some(p => c.req.path.startsWith(p))) {
      await next();
      return;
    }

    // Health check exception
    if (c.req.path.endsWith('/health')) {
      await next();
      return;
    }

    const authHeader = c.req.header('Authorization');
    const apiKeyHeader = c.req.header('X-API-Key');
    let token = '';

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (apiKeyHeader) {
      token = apiKeyHeader;
    }

    if (!token) {
      return c.json(error('UNAUTHORIZED', 'Missing authentication token'), 401);
    }

    // Check against secfn API keys
    // Assuming CIFN_API_KEYS is a comma-separated list of valid keys
    const apiKeysStr = await secFn.getSecret('CIFN_API_KEYS');
    const apiKeys = apiKeysStr ? apiKeysStr.split(',').map(k => k.trim()) : [];

    if (apiKeys.includes(token)) {
      await next();
      return;
    }

    return c.json(error('UNAUTHORIZED', 'Invalid authentication token'), 401);
  };
};
