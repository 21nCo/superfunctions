import type { Participant, ParticipantRole } from 'recfn';
import type { Page } from 'playwright';

export interface MeetParticipantTracker {
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
        // Meet participant list: [data-participant-id] or similar
        // Poll-based fallback when MutationObserver isn't feasible cross-frame
        const poll = async () => {
          if (!observerActive) return;
          const result = await page.evaluate(() => {
            const items = document.querySelectorAll(
              '[data-participant-id], [data-self-name], .zWGUib, [aria-label*="participant"]',
            );
            const entries: Array<{ id: string; name: string }> = [];
            items.forEach((el: Element, i: number) => {
              const id = (el as HTMLElement).getAttribute?.('data-participant-id') ?? `p_${i}`;
              const name =
                (el as HTMLElement).getAttribute?.('data-self-name') ??
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

          // Detect leaves: participants in our map but not in DOM
          for (const [id] of participants) {
            const stillPresent = result.some((r) => r.id === id);
            if (!stillPresent) {
              const p = participants.get(id);
              if (p) {
                p.leftAt = new Date().toISOString();
              }
              participants.delete(id);
              for (const cb of leaveCallbacks) {
                cb(id);
              }
            }
          }
        };

        await poll();
        const interval = setInterval(poll, 2000);
        const stop = () => {
          clearInterval(interval);
        };
        (this as unknown as { _stopPoll?: () => void })._stopPoll = stop;
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
