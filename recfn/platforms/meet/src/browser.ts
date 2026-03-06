/**
 * Headless browser management for Google Meet.
 * Uses Playwright to launch Chrome, navigate to Meet URL, and control the meeting.
 *
 * Prerequisites:
 * - Chrome/Chromium installed (Playwright installs it via `npx playwright install chromium`)
 * - Google account for bot (optional — some meetings allow anonymous "Ask to join";
 *   meetings that require auth need a pre-authenticated browser profile)
 */

import type { Browser, BrowserContext, Page } from 'playwright';

export interface MeetBrowserConfig {
  /** Playwright browser instance. Caller manages lifecycle. */
  browser: Browser;
  /** Optional: persistent context path for pre-authenticated Google account */
  userDataDir?: string;
  /** Join timeout in ms. Default 30000. */
  joinTimeout?: number;
}

export interface MeetBrowserSession {
  page: Page;
  context: BrowserContext;
  close(): Promise<void>;
}

/**
 * Launches a browser context and navigates to a Google Meet URL.
 * Caller must provide a Playwright Browser instance.
 */
export async function createMeetBrowserSession(
  config: MeetBrowserConfig,
  meetingUrl: string,
): Promise<MeetBrowserSession> {
  const { browser, userDataDir, joinTimeout = 30_000 } = config;

  const contextOptions: { userDataDir?: string } = {};
  if (userDataDir) {
    contextOptions.userDataDir = userDataDir;
  }

  const context = await browser.newContext({
    ...contextOptions,
    permissions: ['microphone', 'camera'],
  });

  const page = await context.newPage();

  await page.goto(meetingUrl, {
    waitUntil: 'domcontentloaded',
    timeout: joinTimeout,
  });

  return {
    page,
    context,
    async close() {
      await context.close();
    },
  };
}
