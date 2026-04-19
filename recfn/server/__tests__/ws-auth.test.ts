import { describe, it, expect, vi } from 'vitest';
import {
  authenticateWebSocket,
  authorizeTranscriptSubscription,
} from '../src/ws/auth.js';
import { MemoryLogger as ServerMemoryLogger } from '../src/index.js';
import type { IncomingMessage } from 'node:http';

describe('authenticateWebSocket', () => {
  it('authenticates with valid token in query param', async () => {
    const req = {
      url: '/ws/transcripts/bot_123?token=valid_token',
      headers: { host: 'localhost' },
    } as IncomingMessage;

    const validateApiKey = vi.fn().mockResolvedValue({
      namespace: 'ns_test',
      apiKey: 'valid_token',
    });
    const verifyBotAccess = vi.fn().mockResolvedValue(true);
    
    const result = await authenticateWebSocket(req, validateApiKey, verifyBotAccess);
    
    expect(result).toEqual({ ok: true, botId: 'bot_123', namespace: 'ns_test' });
    expect(validateApiKey).toHaveBeenCalledWith('valid_token');
    expect(verifyBotAccess).toHaveBeenCalledWith('bot_123', 'ns_test');
  });

  it('rejects invalid token in query param', async () => {
    const req = {
      url: '/ws/transcripts/bot_123?token=invalid_token',
      headers: { host: 'localhost' },
    } as IncomingMessage;

    const validateApiKey = vi.fn().mockResolvedValue(null);
    const verifyBotAccess = vi.fn();
    const logger = new ServerMemoryLogger();
    
    const result = await authenticateWebSocket(req, validateApiKey, verifyBotAccess, logger);
    
    expect(result).toEqual({
      ok: false,
      botId: 'bot_123',
      code: 'UNAUTHORIZED',
      httpStatus: 401,
    });
    expect(verifyBotAccess).not.toHaveBeenCalled();
    expect(logger.findByEvent('ws.auth.failed')).toEqual([
      expect.objectContaining({
        level: 'warn',
        data: {
          botId: 'bot_123',
          code: 'UNAUTHORIZED',
          httpStatus: 401,
        },
      }),
    ]);
  });

  it('defers auth if no token provided', async () => {
    const req = {
      url: '/ws/transcripts/bot_123',
      headers: { host: 'localhost' },
    } as IncomingMessage;

    const validateApiKey = vi.fn();
    const verifyBotAccess = vi.fn();
    const logger = new ServerMemoryLogger();
    
    const result = await authenticateWebSocket(req, validateApiKey, verifyBotAccess, logger);
    
    expect(result).toEqual({ ok: false, botId: 'bot_123', deferred: true });
    expect(validateApiKey).not.toHaveBeenCalled();
    expect(verifyBotAccess).not.toHaveBeenCalled();
    expect(logger.findByEvent('ws.auth.deferred')).toEqual([
      expect.objectContaining({
        level: 'info',
        data: {
          botId: 'bot_123',
        },
      }),
    ]);
  });

  it('fails if path is not matching', async () => {
    const req = {
      url: '/other/path',
      headers: { host: 'localhost' },
    } as IncomingMessage;

    const validateApiKey = vi.fn();
    const verifyBotAccess = vi.fn();
    const logger = new ServerMemoryLogger();
    
    const result = await authenticateWebSocket(req, validateApiKey, verifyBotAccess, logger);
    
    expect(result).toEqual({ ok: false, httpStatus: 400 });
    expect(logger.findByEvent('ws.auth.failed')).toEqual([
      expect.objectContaining({
        level: 'warn',
        data: {
          code: 'BAD_REQUEST',
          httpStatus: 400,
        },
      }),
    ]);
  });

  it('rejects cross-namespace query auth for foreign bots (TV-WS-001)', async () => {
    const req = {
      url: '/ws/transcripts/bot_ns_b?token=valid_token',
      headers: { host: 'localhost' },
    } as IncomingMessage;

    const validateApiKey = vi.fn().mockResolvedValue({
      namespace: 'ns_a',
      apiKey: 'valid_token',
    });
    const verifyBotAccess = vi.fn().mockResolvedValue(false);

    const result = await authenticateWebSocket(req, validateApiKey, verifyBotAccess);

    expect(result).toEqual({
      ok: false,
      botId: 'bot_ns_b',
      code: 'WS_NAMESPACE_FORBIDDEN',
      httpStatus: 403,
    });
    expect(verifyBotAccess).toHaveBeenCalledWith('bot_ns_b', 'ns_a');
  });
});

describe('authorizeTranscriptSubscription', () => {
  it('shares the same namespace check for deferred auth (TV-WS-001)', async () => {
    const validateApiKey = vi.fn().mockResolvedValue({
      namespace: 'ns_b',
      apiKey: 'sk-ns-b',
    });
    const verifyBotAccess = vi.fn().mockResolvedValue(true);
    const logger = new ServerMemoryLogger();

    const result = await authorizeTranscriptSubscription(
      'bot_ns_b',
      'sk-ns-b',
      validateApiKey,
      verifyBotAccess,
      logger,
    );

    expect(result).toEqual({
      ok: true,
      botId: 'bot_ns_b',
      namespace: 'ns_b',
    });
    expect(logger.findByEvent('ws.auth.failed')).toHaveLength(0);
  });

  it('logs namespace failures for deferred auth checks', async () => {
    const validateApiKey = vi.fn().mockResolvedValue({
      namespace: 'ns_a',
      apiKey: 'sk-ns-a',
    });
    const verifyBotAccess = vi.fn().mockResolvedValue(false);
    const logger = new ServerMemoryLogger();

    const result = await authorizeTranscriptSubscription(
      'bot_ns_b',
      'sk-ns-a',
      validateApiKey,
      verifyBotAccess,
      logger,
    );

    expect(result).toEqual({
      ok: false,
      botId: 'bot_ns_b',
      code: 'WS_NAMESPACE_FORBIDDEN',
      httpStatus: 403,
    });
    expect(logger.findByEvent('ws.auth.failed')).toEqual([
      expect.objectContaining({
        level: 'warn',
        data: {
          botId: 'bot_ns_b',
          namespace: 'ns_a',
          code: 'WS_NAMESPACE_FORBIDDEN',
          httpStatus: 403,
        },
      }),
    ]);
  });
});
