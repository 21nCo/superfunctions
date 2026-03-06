import type { ChatMessage } from 'recfn';
import type { Page } from 'playwright';

export interface TeamsChatTracker {
  getMessages(): ChatMessage[];
  onMessage(cb: (msg: ChatMessage) => void): void;
  send(text: string): Promise<void>;
  startObserving(): Promise<void>;
  stopObserving(): void;
}

/**
 * DOM-based chat capture and send for Microsoft Teams.
 */
export function createTeamsChatTracker(page: Page): TeamsChatTracker {
  const messages: ChatMessage[] = [];
  const messageCallbacks: Array<(msg: ChatMessage) => void> = [];
  let observerActive = false;

  return {
    getMessages(): ChatMessage[] {
      return [...messages];
    },

    onMessage(cb: (msg: ChatMessage) => void): void {
      messageCallbacks.push(cb);
    },

    async send(text: string): Promise<void> {
      try {
        const input = await page.$(
          '[data-tid="chat-input"], [aria-label*="chat"] input, [placeholder*="Type"]',
        );
        if (input) {
          await input.fill(text);
          await page.keyboard.press('Enter');
        }
      } catch {
        // Non-fatal
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
              '[data-tid="chat-message"], .message-body, [data-id*="message"]',
            );
            const entries: Array<{ participantId: string; text: string; timestamp: string }> = [];
            items.forEach((el: Element, i: number) => {
              const participantId =
                (el as HTMLElement).getAttribute?.('data-sender-id') ?? `sender_${i}`;
              const text = (el as HTMLElement).textContent?.trim() ?? '';
              const timestamp = new Date().toISOString();
              entries.push({ participantId, text, timestamp });
            });
            return entries;
          });

          for (const entry of result) {
            const existing = messages.find(
              (m) => m.participantId === entry.participantId && m.text === entry.text,
            );
            if (!existing && entry.text) {
              const msg: ChatMessage = {
                participantId: entry.participantId,
                text: entry.text,
                timestamp: entry.timestamp,
              };
              messages.push(msg);
              for (const cb of messageCallbacks) {
                cb(msg);
              }
            }
          }
        };

        await poll();
        const interval = setInterval(poll, 1500);
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
