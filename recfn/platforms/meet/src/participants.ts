import type { Participant } from '@recfn/core';
import type { Page } from 'playwright';
import { createBrowserParticipantTracker } from '@recfn/browser-core';

export interface MeetParticipantTracker {
  getAll(): Participant[];
  onJoin(cb: (p: Participant) => void): void;
  onLeave(cb: (id: string) => void): void;
  setBotId(botId: string): void;
  startObserving(): Promise<void>;
  stopObserving(): void;
}

/**
 * DOM-based participant tracking for Google Meet.
 * Observes the participant list panel for join/leave events.
 *
 * Meet's DOM structure may change; selectors are best-effort.
 * See: https://meet.google.com DOM inspection.
 */
export function createMeetParticipantTracker(
  page: Page,
  botId: string,
): MeetParticipantTracker {
  return createBrowserParticipantTracker({
    page,
    botId,
    evaluateParticipants: () => {
      const items = document.querySelectorAll(
        '[data-participant-id], [data-self-name], .zWGUib, [aria-label*="participant"]',
      );
      const entries: Array<{ id: string; name: string }> = [];
      items.forEach((el: Element, i: number) => {
        const id =
          (el as HTMLElement).getAttribute?.('data-participant-id') ?? `p_${i}`;
        const name =
          (el as HTMLElement).getAttribute?.('data-self-name') ??
          (el as HTMLElement).textContent?.trim() ??
          `Participant ${i}`;
        entries.push({ id, name });
      });
      return entries;
    },
  });
}
