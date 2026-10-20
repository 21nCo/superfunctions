import { afterEach, expect, it, vi } from 'vitest';
import { UserFnClient, FeedbackDeliveryError, FeedbackHTTPError } from '../index';
const feedback = { title: 'Bug', body: 'Details 文', category: 'bug' as const };
afterEach(() => { vi.unstubAllGlobals(); });

it('uses the configured endpoint/key and retries transient status with identical body and idempotency key', async () => {
  const transport = vi.fn().mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    .mockResolvedValueOnce(Response.json({ id: 'stored', accepted: true }, { status: 201 }));
  vi.stubGlobal('fetch', transport);
  const client = new UserFnClient({ endpoint: 'https://service.example/api/', apiKey: 'secret', feedbackMaxAttempts: 2 });
  client.identify('user', { plan: 'pro' });
  await client.submitFeedback(feedback);
  expect(transport).toHaveBeenCalledTimes(2);
  const first = transport.mock.calls[0]; const second = transport.mock.calls[1];
  expect(first[0]).toBe('https://service.example/api/feedback');
  expect(first[1].headers.authorization).toBe('Bearer secret');
  expect(first[1].headers['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
  expect(second[1].headers['idempotency-key']).toBe(first[1].headers['idempotency-key']);
  expect(second[1].body).toBe(first[1].body);
  expect(JSON.parse(first[1].body)).toEqual({ feedback, context: { source: 'in_app', user: { id: 'user', traits: { plan: 'pro' } } } });
  expect(first[1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
});

it('retries network failure but does not retry rejection or malformed success', async () => {
  const transport = vi.fn().mockRejectedValueOnce(new TypeError('network failure')).mockResolvedValueOnce(Response.json({ id: 'stored', accepted: true }));
  vi.stubGlobal('fetch', transport);
  const client = new UserFnClient({ endpoint: 'https://service.example', apiKey: 'key', feedbackMaxAttempts: 2 });
  await client.submitFeedback(feedback, { idempotencyKey: 'manual-key' });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[1][1].headers['idempotency-key']).toBe('manual-key');
  for (const response of [new Response('private secret', { status: 401 }), new Response('not JSON'), Response.json({ accepted: false }), new Response('x'.repeat(65537))]) {
    transport.mockReset().mockResolvedValue(response);
    await expect(client.submitFeedback(feedback)).rejects.toBeInstanceOf(FeedbackDeliveryError);
    expect(transport).toHaveBeenCalledOnce();
  }
});

it('surfaces conflict status without retry and aborts timed-out attempts', async () => {
  const transport = vi.fn().mockResolvedValue(new Response('conflict', { status: 409 }));
  vi.stubGlobal('fetch', transport);
  const client = new UserFnClient({ endpoint: 'https://service.example', apiKey: 'key', feedbackMaxAttempts: 1, feedbackTimeoutMs: 5 });
  await expect(client.submitFeedback(feedback)).rejects.toMatchObject({ status: 409, name: 'FeedbackHTTPError' });
  expect(transport).toHaveBeenCalledOnce();
  transport.mockReset().mockImplementation((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
  await expect(client.submitFeedback(feedback)).rejects.toMatchObject({ name: 'AbortError' });
  expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
});

it('rejects unsafe endpoint configuration, invalid keys and oversized requests before transport', async () => {
  const transport = vi.fn(); vi.stubGlobal('fetch', transport);
  for (const endpoint of ['file:///etc/passwd', 'https://user:password@example.test', 'https://example.test?key=secret']) {
    expect(() => new UserFnClient({ endpoint, apiKey: 'key' })).toThrow();
  }
  const client = new UserFnClient({ endpoint: 'https://service.example', apiKey: 'key' });
  await expect(client.submitFeedback(feedback, { idempotencyKey: 'bad key' })).rejects.toThrow('idempotency');
  await expect(client.submitFeedback({ ...feedback, body: 'x'.repeat(65537) })).rejects.toThrow('65536');
  expect(transport).not.toHaveBeenCalled();
});

it('rejects malformed board, vote and moderation acknowledgments without retry', async () => {
  const transport = vi.fn(); vi.stubGlobal('fetch', transport);
  const client = new UserFnClient({ endpoint: 'https://service.example', apiKey: 'key' });
  const id = 'uf_' + 'a'.repeat(64);
  for (const [reply, operation] of [
    [{ items: [], nextCursor: 42 }, () => client.getFeedbackBoard()],
    [{ id, votes: '1', viewerVote: 1 }, () => client.voteFeedback(id, 1)],
    [{ id, status: 'closed' }, () => client.setFeedbackStatus(id, 'planned')],
  ] as const) {
    transport.mockReset().mockResolvedValue(Response.json(reply));
    await expect(operation()).rejects.toBeInstanceOf(FeedbackDeliveryError);
    expect(transport).toHaveBeenCalledOnce();
  }
  transport.mockReset();
  await expect(client.voteFeedback('../escape', 1)).rejects.toBeInstanceOf(TypeError);
  expect(transport).not.toHaveBeenCalled();
});

it('retries an idempotent vote with the same target and direction', async () => {
  const id = 'uf_' + 'b'.repeat(64);
  const transport = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(Response.json({ id, votes: -1, viewerVote: -1 }));
  vi.stubGlobal('fetch', transport);
  const client = new UserFnClient({ endpoint: 'https://service.example', apiKey: 'key', feedbackMaxAttempts: 2 });
  expect(await client.voteFeedback(id, -1)).toEqual({ id, votes: -1, viewerVote: -1 });
  expect(transport.mock.calls[0][0]).toBe(transport.mock.calls[1][0]);
  expect(transport.mock.calls[0][1].body).toBe(transport.mock.calls[1][1].body);
});


it('validates metadata acknowledgments and retries identical patches', async () => {
  const id = 'uf_' + 'c'.repeat(64);
  const patch = { tags: [' UI ', 'UI'], productArea: null };
  const reply = { id, tags: ['UI'], productArea: null };
  const transport = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(Response.json(reply));
  vi.stubGlobal('fetch', transport);
  const client = new UserFnClient({ endpoint: 'https://service.example', apiKey: 'key', feedbackMaxAttempts: 2 });
  expect(await client.setFeedbackMetadata(id, patch)).toEqual(reply);
  expect(transport.mock.calls[0][0]).toBe(`https://service.example/feedback/${id}/metadata`);
  expect(transport.mock.calls[0][1].method).toBe('PATCH');
  expect(transport.mock.calls[0][1].body).toBe(transport.mock.calls[1][1].body);
  for (const invalid of [{}, { ...reply, tags: null }, { ...reply, tags: ['different'] }, { ...reply, productArea: 'different' }, { ...reply, id: 'wrong' }]) {
    transport.mockReset().mockResolvedValue(Response.json(invalid));
    await expect(client.setFeedbackMetadata(id, patch)).rejects.toBeInstanceOf(FeedbackDeliveryError);
    expect(transport).toHaveBeenCalledOnce();
  }
  transport.mockReset();
  for (const invalid of [{}, { tags: undefined }, { tags: [42] }, { tags: [' '] }, { productArea: undefined }, { tags: [], actorId: 'spoof' }]) await expect(client.setFeedbackMetadata(id, invalid as any)).rejects.toBeInstanceOf(TypeError);
  expect(transport).not.toHaveBeenCalled();
  await expect(new UserFnClient({ apiKey: 'key' }).setFeedbackMetadata(id, patch)).rejects.toThrow('not configured');
});
