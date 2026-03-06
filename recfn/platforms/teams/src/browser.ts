/**
 * Headless browser management for Microsoft Teams.
 * Uses Playwright to launch Chrome, navigate to Teams meeting URL, and control the meeting.
 *
 * Approach: Headless browser (chosen over Graph Communications API for simpler setup).
 * - Graph API requires Azure Bot registration, app registration, and complex auth.
 * - Headless browser works with standard Teams meeting links; requires Microsoft account for auth.
 *
 * Prerequisites:
 * - Chrome/Chromium: `npx playwright install chromium`
 * - Microsoft account for bot (Teams typically requires sign-in to join)
 */

import type { Browser, BrowserContext, Page } from 'playwright';

export interface TeamsBrowserConfig {
  /** Playwright browser instance. Caller manages lifecycle. */
  browser: Browser;
  /** Optional: persistent context path for pre-authenticated Microsoft account */
  userDataDir?: string;
  /** Join timeout in ms. Default 30000. */
  joinTimeout?: number;
}

export interface TeamsBrowserSession {
  page: Page;
  context: BrowserContext;
  close(): Promise<void>;
}

/**
 * Launches a browser context and navigates to a Microsoft Teams meeting URL.
 */
export async function createTeamsBrowserSession(
  config: TeamsBrowserConfig,
  meetingUrl: string,
): Promise<TeamsBrowserSession> {
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
