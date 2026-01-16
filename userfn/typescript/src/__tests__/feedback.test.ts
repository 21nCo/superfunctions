import { describe, it, expect, vi } from 'vitest';
import { FeedbackEngine } from '../core/feedback';

describe('FeedbackEngine', () => {
  it('submits feedback', async () => {
    const engine = new FeedbackEngine();
    const spy = vi.spyOn(console, 'log'); // Mock console log to verify
    
    await engine.submit({
      title: 'Bug',
      body: 'It crashes',
      category: 'bug'
    });
    
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[UserFn] Submitting feedback'), expect.anything());
    spy.mockRestore();
  });
});
