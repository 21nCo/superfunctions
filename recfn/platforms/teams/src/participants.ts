import type { Participant } from 'recfn';
import type { Page } from 'playwright';
import { createBrowserParticipantTracker } from 'recfn-browser-core';

export interface TeamsParticipantTracker {
  getAll(): Participant[];
  onJoin(cb: (p: Participant) => void): void;
  onLeave(cb: (id: string) => void): void;
  setBotId(botId: string): void;
  startObserving(): Promise<void>;
  stopObserving(): void;
}

/**
 * DOM-based participant tracking for Microsoft Teams.
 * Observes the participant list panel for join/leave events.
 */
export function createTeamsParticipantTracker(
  page: Page,
  botId: string,
): TeamsParticipantTracker {
  return createBrowserParticipantTracker({
    page,
    botId,
    evaluateParticipants: () => {
      const items = document.querySelectorAll(
        '[data-tid="participant-list-item"], [data-id*="participant"], .roster-list-item, [aria-label*="participant"]',
      );
      const entries: Array<{ id: string; name: string }> = [];
      items.forEach((el: Element, i: number) => {
        const id = (el as HTMLElement).getAttribute?.('data-id') ?? `p_${i}`;
        const name =
          (el as HTMLElement).getAttribute?.('data-display-name') ??
          (el as HTMLElement).textContent?.trim() ??
          `Participant ${i}`;
        entries.push({ id, name });
      });
      return entries;
    },
  });
}
