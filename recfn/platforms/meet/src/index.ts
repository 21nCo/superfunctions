import type {
  PlatformAdapter,
  BotConfig,
  Participant,
  ChatMessage,
  MeetingMetadata,
  AudioChunk,
} from 'recfn';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
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
  /**
   * Playwright Browser instance. If not provided, adapter launches chromium.
   * For tests, inject a mock Browser.
   */
  browser?: Browser;
  /**
   * For tests: inject a mock Page directly. Skips browser launch.
   */
  testPage?: Page;
  /** Persistent user data dir for pre-authenticated Google account */
  userDataDir?: string;
  /** Join timeout in ms. Default 30000. */
  joinTimeout?: number;
}

/**
 * Google Meet platform adapter using headless browser (Playwright).
 *
 * Prerequisites:
 * - Chrome/Chromium: `npx playwright install chromium`
 * - Google account for bot (optional; some meetings allow "Ask to join" without auth)
 */
export class MeetAdapter implements PlatformAdapter {
  readonly platform = 'meet' as const;

  private config: MeetAdapterConfig;
  private session: Awaited<ReturnType<typeof createMeetBrowserSession>> | null =
    null;
  private participantTracker: MeetParticipantTracker | null = null;
  private chatTracker: MeetChatTracker | null = null;
  private connected = false;
  private botId = '';
  private participantJoinCbs: Array<(p: Participant) => void> = [];
  private participantLeaveCbs: Array<(id: string) => void> = [];
  private chatMessageCbs: Array<(msg: ChatMessage) => void> = [];

  constructor(config: MeetAdapterConfig = {}) {
    this.config = config;
  }

  async join(meetingUrl: string, botConfig: BotConfig): Promise<void> {
    const joinTimeout = this.config.joinTimeout ?? botConfig.joinTimeout ?? 30_000;

    let page: Page;

    if (this.config.testPage) {
      page = this.config.testPage;
      this.session = {
        page,
        context: null as unknown as import('playwright').BrowserContext,
        async close() {},
      };
    } else {
      let browser: Browser;
      if (this.config.browser) {
        browser = this.config.browser;
      } else {
        browser = await chromium.launch({
          headless: true,
          args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
        });
      }

      this.session = await createMeetBrowserSession(
        {
          browser,
          userDataDir: this.config.userDataDir,
          joinTimeout,
        },
        meetingUrl,
      );
      page = this.session.page;
    }

    // Wait for Meet to load, then click "Join now" or "Ask to join"
    try {
      const joinClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        const joinBtn = buttons.find(
          (b) =>
            /join now|ask to join/i.test((b as HTMLElement).innerText ?? '') ||
            (b as HTMLElement).getAttribute?.('aria-label')?.toLowerCase().includes('join'),
        ) as HTMLButtonElement | undefined;
        if (joinBtn) {
          joinBtn.click();
          return true;
        }
        return false;
      });

      if (!joinClicked) {
        await page.waitForSelector('[data-meet-id], .zWGUib, [aria-label*="Meeting"]', {
          timeout: Math.min(joinTimeout, 15000),
        }).catch(() => {});
      }

      await page.waitForTimeout(2000);
    } catch {
      // Proceed — may already be in meeting or DOM differs
    }

    this.connected = true;
    this.participantTracker = createMeetParticipantTracker(page, this.botId);
    this.chatTracker = createMeetChatTracker(page);

    for (const cb of this.participantJoinCbs) {
      this.participantTracker.onJoin(cb);
    }
    for (const cb of this.participantLeaveCbs) {
      this.participantTracker.onLeave(cb);
    }
    for (const cb of this.chatMessageCbs) {
      this.chatTracker.onMessage(cb);
    }

    await this.participantTracker.startObserving();
    await this.chatTracker.startObserving();
  }

  async leave(): Promise<void> {
    if (this.participantTracker) {
      this.participantTracker.stopObserving();
    }
    if (this.chatTracker) {
      this.chatTracker.stopObserving();
    }

    if (this.session) {
      try {
        await this.session.page.evaluate(() => {
          const leaveBtn = document.querySelector(
            '[aria-label*="Leave"], [aria-label*="Leave call"]',
          ) as HTMLButtonElement | null;
          if (leaveBtn) leaveBtn.click();
        });
        await this.session.page.waitForTimeout(1000);
      } catch {
        // Ignore
      }
      await this.session.close();
      this.session = null;
    }

    this.participantTracker = null;
    this.chatTracker = null;
    this.connected = false;
  }

  getAudioStream(): ReadableStream<AudioChunk> {
    if (!this.session) {
      return new ReadableStream();
    }
    return createMeetAudioStream(this.session.page);
  }

  async getParticipants(): Promise<Participant[]> {
    if (!this.participantTracker) return [];
    return this.participantTracker.getAll();
  }

  onParticipantJoin(cb: (p: Participant) => void): void {
    this.participantJoinCbs.push(cb);
    if (this.participantTracker) {
      this.participantTracker.onJoin(cb);
    }
  }

  onParticipantLeave(cb: (id: string) => void): void {
    this.participantLeaveCbs.push(cb);
    if (this.participantTracker) {
      this.participantTracker.onLeave(cb);
    }
  }

  async getChatMessages(): Promise<ChatMessage[]> {
    if (!this.chatTracker) return [];
    return this.chatTracker.getMessages();
  }

  onChatMessage(cb: (msg: ChatMessage) => void): void {
    this.chatMessageCbs.push(cb);
    if (this.chatTracker) {
      this.chatTracker.onMessage(cb);
    }
  }

  async sendChatMessage(text: string): Promise<void> {
    if (this.chatTracker) {
      await this.chatTracker.send(text);
    }
  }

  async getMetadata(): Promise<MeetingMetadata> {
    let title = 'Google Meet';
    if (this.session) {
      try {
        title =
          (await this.session.page.title()) ?? 'Google Meet';
      } catch {
        // Ignore
      }
    }
    const chatMessages = this.chatTracker ? this.chatTracker.getMessages() : [];
    return {
      id: 'meet',
      botId: this.botId,
      title,
      platform: 'meet',
      chatMessages,
    };
  }

  isConnected(): boolean {
    return this.connected;
  }
}
