import type { ChatMessage } from '@recfn/core';
import type { Page } from 'playwright';
import { createBrowserChatTracker } from '@recfn/browser-core';

export interface MeetChatTracker {
  getMessages(): ChatMessage[];
  onMessage(cb: (msg: ChatMessage) => void): void;
  send(text: string): Promise<void>;
  startObserving(): Promise<void>;
  stopObserving(): void;
}

/**
 * DOM-based chat capture and send for Google Meet.
 * Observes the chat panel for new messages.
 * Sends messages by typing into the chat input.
 */
export function createMeetChatTracker(
  page: Page,
): MeetChatTracker {
  return createBrowserChatTracker({
    page,
    evaluateMessages: () => {
      const items = document.querySelectorAll(
        '[data-message-id], .zWGUib [data-sender], .chat-message',
      );
      const entries: Array<{
        participantId: string;
        text: string;
        timestamp: string;
      }> = [];
      items.forEach((el: Element, i: number) => {
        const participantId =
          (el as HTMLElement).getAttribute?.('data-sender') ?? `sender_${i}`;
        const text = (el as HTMLElement).textContent?.trim() ?? '';
        const timestamp = new Date().toISOString();
        entries.push({ participantId, text, timestamp });
      });
      return entries;
    },
    sendMessage: async (currentPage, text) => {
      const input = await currentPage.$(
        '[data-idom-class*="chat"], [aria-label*="chat"] input, [placeholder*="message"]',
      );
      if (input) {
        await input.fill(text);
        await currentPage.keyboard.press('Enter');
      }
    },
  });
}
