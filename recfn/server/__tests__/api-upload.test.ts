import { describe, it, expect } from 'vitest';
import {
  createTestServer,
  req,
  json,
} from './helpers.js';

describe('POST /api/v1/recordings/upload', () => {
  it('returns 401 without auth', async () => {
    const { server } = createTestServer();
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'rec.webm');

    const res = await server.router.handle(
      new Request('http://localhost/api/v1/recordings/upload?botId=bot_1', {
        method: 'POST',
        body: formData,
      }),
    );

    expect(res.status).toBe(401);
  });

  it('returns 400 when botId missing', async () => {
    const { server } = createTestServer();
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'rec.webm');

    const res = await server.router.handle(
      new Request('http://localhost/api/v1/recordings/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer sk-valid-key' },
        body: formData,
      }),
    );

    expect(res.status).toBe(400);
  });

  it('returns 404 when bot not found', async () => {
    const { server } = createTestServer();
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'rec.webm');

    const res = await server.router.handle(
      new Request('http://localhost/api/v1/recordings/upload?botId=nonexistent', {
        method: 'POST',
        headers: { Authorization: 'Bearer sk-valid-key' },
        body: formData,
      }),
    );

    expect(res.status).toBe(404);
  });

  it('uploads and returns recording (TV-DSK-001)', async () => {
    const { server } = createTestServer();
    const createRes = await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/1234567890' },
      }),
    );
    expect(createRes.status).toBe(201);
    const createBody = await json(createRes);
    const botId = (createBody.data as { id: string }).id;

    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array([1, 2, 3, 4, 5])]), 'rec.webm');

    const res = await server.router.handle(
      new Request(`http://localhost/api/v1/recordings/upload?botId=${botId}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer sk-valid-key' },
        body: formData,
      }),
    );

    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.data).toBeDefined();
    const data = body.data as Record<string, unknown>;
    expect(data.id).toMatch(/^rec_/);
    expect(data.botId).toBe(botId);
    expect(data.format).toBe('webm');
    expect(data.size).toBe(5);
  });
});
