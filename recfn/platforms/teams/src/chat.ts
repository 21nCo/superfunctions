import type { ChatMessage } from '@recfn/core';
import type { Page } from 'playwright';
import { createBrowserChatTracker } from '@recfn/browser-core';

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
  return createBrowserChatTracker({
    page,
    evaluateMessages: () => {
      const items = document.querySelectorAll(
        '[data-tid="chat-message"], .message-body, [data-id*="message"]',
      );
      const entries: Array<{
        participantId: string;
        text: string;
        timestamp: string;
      }> = [];
      items.forEach((el: Element, i: number) => {
        const participantId =
          (el as HTMLElement).getAttribute?.('data-sender-id') ?? `sender_${i}`;
        const text = (el as HTMLElement).textContent?.trim() ?? '';
        const timestamp = new Date().toISOString();
        entries.push({ participantId, text, timestamp });
      });
      return entries;
    },
    sendMessage: async (currentPage, text) => {
      const input = await currentPage.$(
        '[data-tid="chat-input"], [aria-label*="chat"] input, [placeholder*="Type"]',
      );
      if (!input) throw new Error('Teams chat input unavailable.');
      await input.fill(text);
      await currentPage.keyboard.press('Enter');
    },
  });
}
