import type { Browser, Page } from 'playwright';
import {
  BrowserAutomationAdapter,
  joinBrowserMeeting,
  leaveBrowserMeeting,
} from 'recfn-browser-core';
import { createTeamsBrowserSession } from './browser.js';
import { createTeamsAudioStream } from './audio-capture.js';
import {
  createTeamsParticipantTracker,
  type TeamsParticipantTracker,
} from './participants.js';
import { createTeamsChatTracker, type TeamsChatTracker } from './chat.js';

export { createTeamsBrowserSession } from './browser.js';
export type { TeamsBrowserConfig, TeamsBrowserSession } from './browser.js';
export { createTeamsAudioStream } from './audio-capture.js';
export { createTeamsParticipantTracker } from './participants.js';
export type { TeamsParticipantTracker } from './participants.js';
export { createTeamsChatTracker } from './chat.js';
export type { TeamsChatTracker } from './chat.js';

export interface TeamsAdapterConfig {
  browser?: Browser;
  testPage?: Page;
  userDataDir?: string;
  joinTimeout?: number;
}

/**
 * Microsoft Teams platform adapter using headless browser (Playwright).
 *
 * Approach: Headless browser (simpler than Graph Communications API which requires
 * Azure Bot registration, app registration, and OAuth setup).
 *
 * Prerequisites:
 * - Chrome/Chromium: `npx playwright install chromium`
 * - Microsoft account for bot (Teams typically requires sign-in)
 */
export class TeamsAdapter extends BrowserAutomationAdapter<
  TeamsParticipantTracker,
  TeamsChatTracker
> {
  constructor(config: TeamsAdapterConfig = {}) {
    super(config, {
      platform: 'teams',
      metadataId: 'teams',
      defaultTitle: 'Microsoft Teams',
      createSession: createTeamsBrowserSession,
      joinMeeting: async (page, joinTimeout) => {
        await joinBrowserMeeting(page, {
          joinTimeout,
          readySelector:
            '[data-tid="meeting-container"], .teams-call-container, [aria-label*="Meeting"]',
          clickJoin: async (joinPage) =>
            joinPage.evaluate(() => {
              const buttons = Array.from(
                document.querySelectorAll('button, [role="button"]'),
              );
              const joinButton = buttons.find(
                (button) =>
                  /join now|join meeting|join/i.test(
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
              '[aria-label*="Leave"], [aria-label*="Leave call"], [data-tid="leave-call"]',
            ) as HTMLButtonElement | null;
            if (leaveButton) {
              leaveButton.click();
            }
          });
        });
      },
      createParticipantTracker: (page, botId) =>
        createTeamsParticipantTracker(page, botId),
      createChatTracker: (page) => createTeamsChatTracker(page),
      createAudioStream: (page) => createTeamsAudioStream(page),
    });
  }
}
