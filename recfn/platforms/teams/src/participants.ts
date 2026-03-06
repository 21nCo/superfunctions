import type { Participant, ParticipantRole } from 'recfn';
import type { Page } from 'playwright';

export interface TeamsParticipantTracker {
  getAll(): Participant[];
  onJoin(cb: (p: Participant) => void): void;
  onLeave(cb: (id: string) => void): void;
  setBotId(botId: string): void;
  startObserving(): Promise<void>;
  stopObserving(): void;
}

function toParticipant(
  id: string,
  name: string,
  botId: string,
  role: ParticipantRole = 'attendee',
): Participant {
  return {
    id,
    botId,
    name,
    role,
    joinedAt: new Date().toISOString(),
    leftAt: undefined,
    consent: 'pending',
  };
}

/**
 * DOM-based participant tracking for Microsoft Teams.
 * Observes the participant list panel for join/leave events.
 */
export function createTeamsParticipantTracker(
  page: Page,
  botId: string,
): TeamsParticipantTracker {
  const participants = new Map<string, Participant>();
  const joinCallbacks: Array<(p: Participant) => void> = [];
  const leaveCallbacks: Array<(id: string) => void> = [];
  let currentBotId = botId;
  let observerActive = false;

  return {
    getAll(): Participant[] {
      return Array.from(participants.values());
    },

    onJoin(cb: (p: Participant) => void): void {
      joinCallbacks.push(cb);
    },

    onLeave(cb: (id: string) => void): void {
      leaveCallbacks.push(cb);
    },

    setBotId(botId: string): void {
      currentBotId = botId;
      for (const p of participants.values()) {
        p.botId = botId;
      }
    },

    async startObserving(): Promise<void> {
      if (observerActive) return;
      observerActive = true;

      try {
        const poll = async () => {
          if (!observerActive) return;
          const result = await page.evaluate(() => {
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
          });

          for (const { id, name } of result) {
            if (!participants.has(id)) {
              const p = toParticipant(id, name, currentBotId);
              participants.set(id, p);
              for (const cb of joinCallbacks) {
                cb(p);
              }
            }
          }

          for (const [id] of participants) {
            const stillPresent = result.some((r) => r.id === id);
            if (!stillPresent) {
              const p = participants.get(id);
              if (p) p.leftAt = new Date().toISOString();
              participants.delete(id);
              for (const cb of leaveCallbacks) {
                cb(id);
              }
            }
          }
        };

        await poll();
        const interval = setInterval(poll, 2000);
        (this as unknown as { _stopPoll?: () => void })._stopPoll = () =>
          clearInterval(interval);
      } catch {
        // Non-fatal
      }
    },

    stopObserving(): void {
      observerActive = false;
      const stop = (this as unknown as { _stopPoll?: () => void })._stopPoll;
      if (stop) stop();
    },
  };
}
