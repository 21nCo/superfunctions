import { describe, it, expect, vi } from 'vitest';
import { authenticateWebSocket } from '../src/ws/auth.js';
import type { IncomingMessage } from 'node:http';

describe('authenticateWebSocket', () => {
  it('authenticates with valid token in query param', async () => {
    const req = {
      url: '/ws/transcripts/bot_123?token=valid_token',
      headers: { host: 'localhost' },
    } as IncomingMessage;

    const validateApiKey = vi.fn().mockResolvedValue({ ok: true });
    
    const result = await authenticateWebSocket(req, validateApiKey);
    
    expect(result).toEqual({ ok: true, botId: 'bot_123' });
    expect(validateApiKey).toHaveBeenCalledWith('valid_token');
  });

  it('rejects invalid token in query param', async () => {
    const req = {
      url: '/ws/transcripts/bot_123?token=invalid_token',
      headers: { host: 'localhost' },
    } as IncomingMessage;

    const validateApiKey = vi.fn().mockResolvedValue({ ok: false });
    
    const result = await authenticateWebSocket(req, validateApiKey);
    
    expect(result).toEqual({ ok: false, botId: 'bot_123' });
  });

  it('defers auth if no token provided', async () => {
    const req = {
      url: '/ws/transcripts/bot_123',
      headers: { host: 'localhost' },
    } as IncomingMessage;

    const validateApiKey = vi.fn();
    
    const result = await authenticateWebSocket(req, validateApiKey);
    
    expect(result).toEqual({ ok: false, botId: 'bot_123', deferred: true });
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  it('fails if path is not matching', async () => {
    const req = {
      url: '/other/path',
      headers: { host: 'localhost' },
    } as IncomingMessage;

    const validateApiKey = vi.fn();
    
    const result = await authenticateWebSocket(req, validateApiKey);
    
    expect(result).toEqual({ ok: false });
  });
});
