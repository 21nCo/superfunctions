import type { Participant, ParticipantRole } from '@recfn/core';
import type { Page } from 'playwright';

export interface BrowserParticipantEntry {
  id: string;
  name: string;
  role?: ParticipantRole;
  joinedAt?: string;
  consent?: Participant['consent'];
}

export interface BrowserParticipantTrackerLike {
  getAll(): Participant[];
  onJoin(cb: (participant: Participant) => void): void;
  onLeave(cb: (participantId: string) => void): void;
  setBotId?(botId: string): void;
  startObserving(): Promise<void>;
  stopObserving(): void;
}

export interface BrowserParticipantTracker extends BrowserParticipantTrackerLike {
  setBotId(botId: string): void;
}

export interface BrowserParticipantTrackerOptions {
  page: Page;
  botId?: string;
  pollIntervalMs?: number;
  evaluateParticipants: () => BrowserParticipantEntry[];
}

function toParticipant(entry: BrowserParticipantEntry, botId: string): Participant {
  return {
    id: entry.id,
    botId,
    name: entry.name,
    role: entry.role ?? 'attendee',
    joinedAt: entry.joinedAt ?? new Date().toISOString(),
    leftAt: undefined,
    consent: entry.consent ?? 'pending',
  };
}

export function createBrowserParticipantTracker(
  options: BrowserParticipantTrackerOptions,
): BrowserParticipantTracker {
  const participants = new Map<string, Participant>();
  const joinCallbacks: Array<(participant: Participant) => void> = [];
  const leaveCallbacks: Array<(participantId: string) => void> = [];
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  let currentBotId = options.botId ?? '';
  let observerActive = false;
  let stopPolling: (() => void) | undefined;

  return {
    getAll(): Participant[] {
      return Array.from(participants.values());
    },

    onJoin(cb: (participant: Participant) => void): void {
      joinCallbacks.push(cb);
    },

    onLeave(cb: (participantId: string) => void): void {
      leaveCallbacks.push(cb);
    },

    setBotId(botId: string): void {
      currentBotId = botId;
      for (const participant of participants.values()) {
        participant.botId = botId;
      }
    },

    async startObserving(): Promise<void> {
      if (observerActive) {
        return;
      }

      observerActive = true;

      try {
        const poll = async () => {
          if (!observerActive) {
            return;
          }

          const snapshot = await options.page.evaluate(options.evaluateParticipants);

          for (const entry of snapshot) {
            if (participants.has(entry.id)) {
              continue;
            }

            const participant = toParticipant(entry, currentBotId);
            participants.set(entry.id, participant);
            for (const cb of joinCallbacks) {
              cb(participant);
            }
          }

          for (const [participantId, participant] of participants) {
            const stillPresent = snapshot.some((entry) => entry.id === participantId);
            if (stillPresent) {
              continue;
            }

            participant.leftAt = new Date().toISOString();
            participants.delete(participantId);
            for (const cb of leaveCallbacks) {
              cb(participantId);
            }
          }
        };

        await poll();
        const interval = setInterval(poll, pollIntervalMs);
        stopPolling = () => clearInterval(interval);
      } catch {
        // Non-fatal: browser DOM polling is best effort.
      }
    },

    stopObserving(): void {
      observerActive = false;
      stopPolling?.();
      stopPolling = undefined;
    },
  };
}
