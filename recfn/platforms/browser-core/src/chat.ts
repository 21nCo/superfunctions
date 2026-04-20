import type { ChatMessage } from 'recfn';
import type { Page } from 'playwright';

export interface BrowserChatEntry {
  participantId: string;
  text: string;
  timestamp?: string;
}

export interface BrowserChatTrackerLike {
  getMessages(): ChatMessage[];
  onMessage(cb: (message: ChatMessage) => void): void;
  send(text: string): Promise<void>;
  startObserving(): Promise<void>;
  stopObserving(): void;
}

export interface BrowserChatTracker extends BrowserChatTrackerLike {}

export interface BrowserChatTrackerOptions {
  page: Page;
  pollIntervalMs?: number;
  evaluateMessages: () => BrowserChatEntry[];
  sendMessage(page: Page, text: string): Promise<void>;
}

export function createBrowserChatTracker(
  options: BrowserChatTrackerOptions,
): BrowserChatTracker {
  const messages: ChatMessage[] = [];
  const messageCallbacks: Array<(message: ChatMessage) => void> = [];
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  let observerActive = false;
  let stopPolling: (() => void) | undefined;

  return {
    getMessages(): ChatMessage[] {
      return [...messages];
    },

    onMessage(cb: (message: ChatMessage) => void): void {
      messageCallbacks.push(cb);
    },

    async send(text: string): Promise<void> {
      try {
        await options.sendMessage(options.page, text);
      } catch {
        // Non-fatal: some meetings disable chat input.
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

          const entries = await options.page.evaluate(options.evaluateMessages);
          for (const entry of entries) {
            if (!entry.text) {
              continue;
            }

            const message: ChatMessage = {
              participantId: entry.participantId,
              text: entry.text,
              timestamp: entry.timestamp ?? new Date().toISOString(),
            };
            const exists = messages.some(
              (current) =>
                current.participantId === message.participantId &&
                current.text === message.text,
            );
            if (exists) {
              continue;
            }

            messages.push(message);
            for (const cb of messageCallbacks) {
              cb(message);
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
