import type { Browser, BrowserContext, Page } from 'playwright';
import { createBrowserSession } from 'recfn-browser-core';

export const TEAMS_AUDIO_CAPTURE_TIMESLICE_MS = 250;
export const TEAMS_AUDIO_CAPTURE_POLL_INTERVAL_MS = 100;

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
  context: BrowserContext | null;
  close(): Promise<void>;
}

/**
 * Launches a browser context and navigates to a Microsoft Teams meeting URL.
 */
export async function createTeamsBrowserSession(
  config: TeamsBrowserConfig,
  meetingUrl: string,
): Promise<TeamsBrowserSession> {
  return createBrowserSession(
    {
      browser: config.browser,
      userDataDir: config.userDataDir,
      joinTimeout: config.joinTimeout,
    },
    meetingUrl,
  );
}
