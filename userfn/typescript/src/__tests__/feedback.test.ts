import { describe, it, expect, vi } from 'vitest';
import { FeedbackEngine } from '../core/feedback';
import { UserFnClient } from '../index';
import type { FeedbackService } from '../types';

const feedback = { title: 'Bug', body: 'It crashes', category: 'bug' as const, tags: ['unicode 文'], attachments: ['https://example.test/image'] };

describe('feedback delivery boundary', () => {
  it('rejects unconfigured delivery and board reads without logging private content', async () => {
    const log = vi.spyOn(console, 'log');
    try {
      await expect(new UserFnClient({ apiKey: 'key' }).submitFeedback(feedback)).rejects.toThrow('not configured');
      await expect(new FeedbackEngine().getFeedbackBoard()).rejects.toThrow('not implemented');
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it('awaits service acceptance with unchanged submission and current identity', async () => {
    let accept!: () => void;
    const gate = new Promise<void>(resolve => { accept = resolve; });
    const submit = vi.fn(async () => { await gate; return { id: 'feedback-1', accepted: true as const }; });
    const client = new UserFnClient({ apiKey: 'key', feedbackService: { submit } });
    client.identify('user-1', { plan: 'pro' });
    let completed = false;
    const pending = client.submitFeedback(feedback).then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(submit).toHaveBeenCalledWith(feedback, { source: 'in_app', user: { id: 'user-1', traits: { plan: 'pro' } } });
    accept(); await pending;
    client.reset(); await client.submitFeedback(feedback);
    expect(submit).toHaveBeenLastCalledWith(feedback, { source: 'in_app', user: null });
  });

  it('propagates service failure without acknowledging it', async () => {
    const error = new Error('storage unavailable');
    const engine = new FeedbackEngine({ submit: async () => { throw error; } });
    await expect(engine.submit(feedback)).rejects.toBe(error);
  });

  it.each([undefined, { id: 'one', accepted: false }, { id: '', accepted: true }])('rejects invalid receipt %j', async receipt => {
    const service = { submit: async () => receipt } as unknown as FeedbackService;
    await expect(new FeedbackEngine(service).submit(feedback)).rejects.toThrow('did not acknowledge');
  });

  it('validates before invoking the service', async () => {
    const submit = vi.fn();
    await expect(new FeedbackEngine({ submit }).submit({ ...feedback, title: ' ' })).rejects.toThrow('requires');
    expect(submit).not.toHaveBeenCalled();
  });
});
