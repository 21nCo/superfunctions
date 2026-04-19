import type { Browser, BrowserContext, Page } from 'playwright';
import { createBrowserSession } from 'recfn-browser-core';

export const MEET_AUDIO_CAPTURE_TIMESLICE_MS = 250;
export const MEET_AUDIO_CAPTURE_POLL_INTERVAL_MS = 100;

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
  context: BrowserContext | null;
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
  return createBrowserSession(
    {
      browser: config.browser,
      userDataDir: config.userDataDir,
      joinTimeout: config.joinTimeout,
    },
    meetingUrl,
  );
}
