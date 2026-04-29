import type { Browser, Page } from 'playwright';
import {
  BrowserAutomationAdapter,
  joinBrowserMeeting,
  leaveBrowserMeeting,
} from 'recfn-browser-core';
import { createMeetBrowserSession } from './browser.js';
import { createMeetAudioStream } from './audio-capture.js';
import {
  createMeetParticipantTracker,
  type MeetParticipantTracker,
} from './participants.js';
import { createMeetChatTracker, type MeetChatTracker } from './chat.js';

export { createMeetBrowserSession } from './browser.js';
export type { MeetBrowserConfig, MeetBrowserSession } from './browser.js';
export { createMeetAudioStream } from './audio-capture.js';
export { createMeetParticipantTracker } from './participants.js';
export type { MeetParticipantTracker } from './participants.js';
export { createMeetChatTracker } from './chat.js';
export type { MeetChatTracker } from './chat.js';

export interface MeetAdapterConfig {
  browser?: Browser;
  testPage?: Page;
  userDataDir?: string;
  joinTimeout?: number;
  headless?: boolean;
  executablePath?: string;
  browserArgs?: string[];
}

/**
 * Google Meet platform adapter using headless browser (Playwright).
 *
 * Prerequisites:
 * - Chrome/Chromium: `npx playwright install chromium`
 * - Google account for bot (optional; some meetings allow "Ask to join" without auth)
 */
export class MeetAdapter extends BrowserAutomationAdapter<
  MeetParticipantTracker,
  MeetChatTracker
> {
  constructor(config: MeetAdapterConfig = {}) {
    super(config, {
      platform: 'meet',
      metadataId: 'meet',
      defaultTitle: 'Google Meet',
      createSession: createMeetBrowserSession,
      joinMeeting: async (page, joinTimeout) => {
        await joinBrowserMeeting(page, {
          joinTimeout,
          readySelector: '[data-meet-id], .zWGUib, [aria-label*="Meeting"]',
          clickJoin: async (joinPage) =>
            joinPage.evaluate(() => {
              const buttons = Array.from(
                document.querySelectorAll('button, [role="button"]'),
              );
              const joinButton = buttons.find(
                (button) =>
                  /join now|ask to join/i.test(
                    (button as HTMLElement).innerText ?? '',
                  ) ||
                  (button as HTMLElement)
                    .getAttribute?.('aria-label')
                    ?.toLowerCase()
                    .includes('join'),
              ) as HTMLButtonElement | undefined;
              if (joinButton) {
                joinButton.click();
                return true;
              }
              return false;
            }),
        });
      },
      leaveMeeting: async (page) => {
        await leaveBrowserMeeting(page, async (leavePage) => {
          await leavePage.evaluate(() => {
            const leaveButton = document.querySelector(
              '[aria-label*="Leave"], [aria-label*="Leave call"]',
            ) as HTMLButtonElement | null;
            if (leaveButton) {
              leaveButton.click();
            }
          });
        });
      },
      createParticipantTracker: (page, botId) =>
        createMeetParticipantTracker(page, botId),
      createChatTracker: (page) => createMeetChatTracker(page),
      createAudioStream: (page) => createMeetAudioStream(page),
    });
  }
}
