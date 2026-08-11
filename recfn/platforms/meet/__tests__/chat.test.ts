import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { createMeetChatTracker } from '../src/chat.js';

function createPage(evaluateResults: unknown[]) {
  const press = vi.fn().mockResolvedValue(undefined);
  const evaluate = vi.fn();
  for (const result of evaluateResults) {
    evaluate.mockResolvedValueOnce(result);
  }

  const page = {
    evaluate,
    keyboard: { press },
  } as unknown as Page;

  return { page, press };
}

describe('Meet caption shortcut', () => {
  it('does not type c when the page reports editable focus', async () => {
    const { page, press } = createPage([false, false, []]);
    const tracker = createMeetChatTracker(page);

    await tracker.startObserving();
    tracker.stopObserving();

    expect(press).not.toHaveBeenCalled();
  });

  it('uses the c fallback when the page reports safe focus', async () => {
    const { page, press } = createPage([false, true, []]);
    const tracker = createMeetChatTracker(page);

    await tracker.startObserving();
    tracker.stopObserving();

    expect(press).toHaveBeenCalledOnce();
    expect(press).toHaveBeenCalledWith('c');
  });
});
