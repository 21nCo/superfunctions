import { afterEach, expect, it, vi } from 'vitest';
import { UserFnClient, SurveyDeliveryError } from '../index';
const receipt = { id: 'a'.repeat(64), surveyId: 's', submittedAt: 123, accepted: true };
const answers = [{ questionId: 'q', value: 5 }];
const make = (extra = {}) => new UserFnClient({ apiKey: 'credential', endpoint: 'https://service.example', surveyMaxAttempts: 1, ...extra });
afterEach(() => vi.unstubAllGlobals());
it('retries the serialized payload/key and never forwards local identity or timestamp', async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { calls.push(init); if (calls.length === 1) throw new TypeError('lost response'); return new Response(JSON.stringify(receipt)); }));
  const options = { apiKey: 'original', endpoint: 'https://service.example', surveyMaxAttempts: 2 };
  const client = new UserFnClient(options); options.apiKey = 'changed'; client.identify('local-user');
  expect(await client.submitSurveyResponse('s', answers, { idempotencyKey: 'stable' })).toEqual(receipt);
  expect(calls).toHaveLength(2); expect(calls[0].body).toBe(calls[1].body);
  expect(JSON.parse(calls[0].body as string)).toEqual({ answers });
  expect(calls[0]).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { authorization: 'Bearer original', 'idempotency-key': 'stable' } });
});
it('rejects unbound, malformed and oversized successful receipts', async () => {
  for (const value of [{ ...receipt, surveyId: 'other' }, { ...receipt, accepted: false }, { ...receipt, submittedAt: -1 }, { ...receipt, id: 'x' }, 'invalid']) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(value))));
    await expect(make().submitSurveyResponse('s', answers, { idempotencyKey: 'key' })).rejects.toBeInstanceOf(SurveyDeliveryError);
  }
  vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(65537))));
  await expect(make().submitSurveyResponse('s', answers, { idempotencyKey: 'key' })).rejects.toThrow('Oversized');
});
it('does not retry cap denial or redirects and bounds a fetch that ignores cancellation', async () => {
  for (const status of [302, 400, 403, 409, 429]) {
    const fetch = vi.fn(async () => new Response(null, { status })); vi.stubGlobal('fetch', fetch);
    await expect(make({ surveyMaxAttempts: 3 }).submitSurveyResponse('s', answers, { idempotencyKey: 'key' })).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(1);
  }
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  await expect(make({ surveyTimeoutMs: 10 }).submitSurveyResponse('s', answers, { idempotencyKey: 'key' })).rejects.toMatchObject({ status: 408 });
});
it('rejects invalid requests before network access', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(make().submitSurveyResponse('s', answers, { idempotencyKey: '../key' })).rejects.toThrow();
  await expect(make().submitSurveyResponse('s', [{ questionId: 'q', value: NaN }], { idempotencyKey: 'key' })).rejects.toThrow();
  await expect(make().submitSurveyResponse('s', [{ questionId: 'q', value: 'x'.repeat(65536) }], { idempotencyKey: 'key' })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
