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
  /** Playwright Browser instance. For tests, inject a mock Browser. */
  browser?: Browser;
  /** For tests: inject a mock Page directly. Skips browser launch. */
  testPage?: Page;
  /** Persistent user data dir for pre-authenticated Microsoft account */
  userDataDir?: string;
  /** Join timeout in ms. Default 30000. */
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
export class TeamsAdapter implements PlatformAdapter {
  readonly platform = 'teams' as const;

  private config: TeamsAdapterConfig;
  private session: Awaited<ReturnType<typeof createTeamsBrowserSession>> | null =
    null;
  private participantTracker: TeamsParticipantTracker | null = null;
  private chatTracker: TeamsChatTracker | null = null;
  private connected = false;
  private botId = '';
  private participantJoinCbs: Array<(p: Participant) => void> = [];
  private participantLeaveCbs: Array<(id: string) => void> = [];
  private chatMessageCbs: Array<(msg: ChatMessage) => void> = [];

  constructor(config: TeamsAdapterConfig = {}) {
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

      this.session = await createTeamsBrowserSession(
        {
          browser,
          userDataDir: this.config.userDataDir,
          joinTimeout,
        },
        meetingUrl,
      );
      page = this.session.page;
    }

    try {
      const joinClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        const joinBtn = buttons.find(
          (b) =>
            /join now|join meeting|join/i.test((b as HTMLElement).innerText ?? '') ||
            (b as HTMLElement).getAttribute?.('aria-label')?.toLowerCase().includes('join'),
        ) as HTMLButtonElement | undefined;
        if (joinBtn) {
          joinBtn.click();
          return true;
        }
        return false;
      });

      if (!joinClicked) {
        await page.waitForSelector(
          '[data-tid="meeting-container"], .teams-call-container, [aria-label*="Meeting"]',
          { timeout: Math.min(joinTimeout, 15000) },
        ).catch(() => {});
      }

      await page.waitForTimeout(2000);
    } catch {
      // Proceed
    }

    this.connected = true;
    this.participantTracker = createTeamsParticipantTracker(page, this.botId);
    this.chatTracker = createTeamsChatTracker(page);

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
            '[aria-label*="Leave"], [aria-label*="Leave call"], [data-tid="leave-call"]',
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
    return createTeamsAudioStream(this.session.page);
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
    let title = 'Microsoft Teams';
    if (this.session) {
      try {
        title = (await this.session.page.title()) ?? 'Microsoft Teams';
      } catch {
        // Ignore
      }
    }
    const chatMessages = this.chatTracker ? this.chatTracker.getMessages() : [];
    return {
      id: 'teams',
      botId: this.botId,
      title,
      platform: 'teams',
      chatMessages,
    };
  }

  isConnected(): boolean {
    return this.connected;
  }
}
