import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SurveyJournal } from '../core/survey-journal';

let values: Map<string, string>;
const owner = JSON.stringify(['alice', 'survey']);
const response = { surveyId: 'survey', answers: [{ questionId: 'score', value: 5 }], submittedAt: 100 };
const receipt = { id: 'a'.repeat(64), surveyId: 'survey', submittedAt: 100, accepted: true as const };
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
const options = { endpoint: 'https://example.test', apiKey: 'credential-secret', surveyJournal: { storageKey: 'owned', storage } };
beforeEach(() => {
  values = new Map();
  const queues = new Map<string, Promise<unknown>>();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('navigator', { locks: { request: (key: string, action: () => Promise<unknown>) => {
    const result = (queues.get(key) ?? Promise.resolve()).then(action); queues.set(key, result.catch(() => {})); return result;
  } } });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('persists before sending and restores the identical key/payload after lost acknowledgement', async () => {
  let key = '';
  await expect(new SurveyJournal(options).submit(owner, 0, response, () => true, async (sent, id) => {
    expect(values.size).toBe(1); expect(sent).toEqual(response); key = id; throw new Error('lost acknowledgement');
  })).rejects.toThrow('lost acknowledgement');
  const restored = new SurveyJournal(options);
  expect((await restored.snapshot('alice'))[owner].pending?.key).toBe(key);
  expect(await restored.snapshot('bob')).toEqual({});
  await restored.submit(owner, 0, { ...response, answers: [] }, () => true, async (sent, id) => {
    expect(sent).toEqual(response); expect(id).toBe(key); return receipt;
  });
  expect((await new SurveyJournal(options).snapshot('alice'))[owner]).toEqual({ count: 1 });
  expect([...values.values()][0]).not.toContain('credential-secret');
});
it('does not send when persistence fails and retains a pending key when receipt persistence fails', async () => {
  const send = vi.fn(async () => receipt);
  const failing = { ...storage, setItem: () => { throw new Error('quota'); } };
  await expect(new SurveyJournal({ ...options, surveyJournal: { storageKey: 'owned', storage: failing } }).submit(owner, 0, response, () => true, send)).rejects.toThrow('quota');
  expect(send).not.toHaveBeenCalled();
  let writes = 0;
  const late = { ...storage, setItem: (key: string, value: string) => { if (++writes === 2) throw new Error('quota'); storage.setItem(key, value); } };
  await expect(new SurveyJournal({ ...options, surveyJournal: { storageKey: 'owned', storage: late } }).submit(owner, 0, response, () => true, send)).rejects.toThrow('quota');
  expect((await new SurveyJournal(options).snapshot('alice'))[owner].pending).toBeDefined();
});
it('serializes distinct clients and prevents stale forms creating a second response', async () => {
  const send = vi.fn(async () => receipt);
  const results = await Promise.all([new SurveyJournal(options), new SurveyJournal(options)].map(journal => journal.submit(owner, 0, response, () => true, send)));
  expect(send).toHaveBeenCalledTimes(1);
  expect(results.filter(result => result.stored)).toHaveLength(1);
});
it('fails closed for credential changes, corrupt state, missing locks and withdrawn identity', async () => {
  const journal = new SurveyJournal(options);
  const send = vi.fn(async () => receipt);
  expect(await journal.submit(owner, 0, response, () => false, send)).toEqual({ count: 0, stored: false });
  expect(send).not.toHaveBeenCalled();
  await journal.submit(owner, 0, response, () => true, send);
  await expect(new SurveyJournal({ ...options, apiKey: 'other' }).snapshot('alice')).rejects.toThrow('credential scope');
  values.set('userfn.surveys.owned', '{broken');
  await expect(journal.snapshot('alice')).rejects.toThrow('journal');
  vi.stubGlobal('navigator', {});
  await expect(journal.snapshot('alice')).rejects.toThrow('journal');
});

it.each([null, false, 0, '', []])('rejects corrupted pending %j without allocating another key', async pending => {
  const journal = new SurveyJournal(options);
  await expect(journal.submit(owner, 0, response, () => true, async () => { throw new Error('lost'); })).rejects.toThrow('lost');
  const key = 'userfn.surveys.owned';
  const state = JSON.parse(values.get(key)!); state.entries[owner].pending = pending;
  values.set(key, JSON.stringify(state));
  const send = vi.fn(async () => receipt);
  await expect(journal.submit(owner, 0, response, () => true, send)).rejects.toThrow('journal');
  expect(send).not.toHaveBeenCalled();
  expect(JSON.parse(values.get(key)!).entries[owner].pending).toEqual(pending);
});
it('retains all entries at capacity and denies a new owner before sending', async () => {
  const journal = new SurveyJournal(options);
  await journal.submit(owner, 0, response, () => true, async () => receipt);
  const key = 'userfn.surveys.owned';
  const state = JSON.parse(values.get(key)!);
  state.entries = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [JSON.stringify(['alice', `s${index}`]), { count: 1 }]));
  const before = JSON.stringify(state); values.set(key, before);
  const send = vi.fn(async () => receipt);
  await expect(journal.submit(owner, 0, response, () => true, send)).rejects.toThrow('capacity');
  expect(send).not.toHaveBeenCalled(); expect(values.get(key)).toBe(before);
});
it('rechecks consent after waiting for a different owner to release the shared lock', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const sending = new Promise<void>(resolve => { started = resolve; });
  const first = new SurveyJournal(options).submit(owner, 0, response, () => true, async () => { started(); await held; return receipt; });
  await sending;
  let valid = true;
  const send = vi.fn(async () => receipt);
  const second = new SurveyJournal(options).submit(JSON.stringify(['bob', 'survey']), 0, response, () => valid, send);
  valid = false; release();
  await first; expect((await second).stored).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(await new SurveyJournal(options).snapshot('bob')).toEqual({});
});
