import type {
  AudioChunk,
  BotConfig,
  ChatMessage,
  MeetingMetadata,
  Participant,
  Platform,
  PlatformAdapter,
} from 'recfn';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { BrowserChatTrackerLike } from './chat.js';
import type { BrowserParticipantTrackerLike } from './participants.js';

export interface BrowserAdapterConfig {
  browser?: Browser;
  testPage?: Page;
  userDataDir?: string;
  joinTimeout?: number;
}

export interface BrowserSession {
  page: Page;
  context: BrowserContext | null;
  close(): Promise<void>;
}

export interface BrowserSessionFactoryConfig {
  browser: Browser;
  userDataDir?: string;
  joinTimeout?: number;
}

export type BrowserSessionFactory = (
  config: BrowserSessionFactoryConfig,
  meetingUrl: string,
) => Promise<BrowserSession>;

export interface BrowserJoinBehavior {
  clickJoin(page: Page): Promise<boolean>;
  readySelector: string;
  joinTimeout: number;
  settleDelayMs?: number;
}

export interface BrowserPlatformHooks<
  P extends BrowserParticipantTrackerLike,
  C extends BrowserChatTrackerLike,
> {
  platform: Platform;
  metadataId: string;
  defaultTitle: string;
  createSession: BrowserSessionFactory;
  joinMeeting(page: Page, joinTimeout: number): Promise<void>;
  leaveMeeting(page: Page): Promise<void>;
  createParticipantTracker(page: Page, botId: string): P;
  createChatTracker(page: Page): C;
  createAudioStream(page: Page): ReadableStream<AudioChunk>;
}

type InternalBotConfig = BotConfig & {
  __botId?: string;
};

export async function createBrowserSession(
  config: BrowserSessionFactoryConfig,
  meetingUrl: string,
): Promise<BrowserSession> {
  const { browser, userDataDir, joinTimeout = 30_000 } = config;
  const context = await browser.newContext({
    ...(userDataDir ? { userDataDir } : {}),
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

export async function joinBrowserMeeting(
  page: Page,
  behavior: BrowserJoinBehavior,
): Promise<void> {
  try {
    const joinClicked = await behavior.clickJoin(page);
    if (!joinClicked) {
      await page
        .waitForSelector(behavior.readySelector, {
          timeout: Math.min(behavior.joinTimeout, 15_000),
        })
        .catch(() => {});
    }

    await page.waitForTimeout(behavior.settleDelayMs ?? 2_000);
  } catch {
    // Proceed: some providers land directly inside the meeting.
  }
}

export async function leaveBrowserMeeting(
  page: Page,
  clickLeave: (page: Page) => Promise<void>,
  settleDelayMs = 1_000,
): Promise<void> {
  try {
    await clickLeave(page);
    await page.waitForTimeout(settleDelayMs);
  } catch {
    // Ignore: meeting may already be closed.
  }
}

async function createManagedBrowserSession(
  config: BrowserAdapterConfig,
  meetingUrl: string,
  joinTimeout: number,
  createSession: BrowserSessionFactory,
): Promise<BrowserSession> {
  if (config.testPage) {
    return {
      page: config.testPage,
      context: null,
      async close() {},
    };
  }

  const browser =
    config.browser ??
    (await chromium.launch({
      headless: true,
      args: [
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    }));

  return createSession(
    {
      browser,
      userDataDir: config.userDataDir,
      joinTimeout,
    },
    meetingUrl,
  );
}

export class BrowserAutomationAdapter<
  P extends BrowserParticipantTrackerLike,
  C extends BrowserChatTrackerLike,
> implements PlatformAdapter {
  readonly platform: Platform;

  private readonly config: BrowserAdapterConfig;
  private readonly hooks: BrowserPlatformHooks<P, C>;
  private session: BrowserSession | null = null;
  private participantTracker: P | null = null;
  private chatTracker: C | null = null;
  private connected = false;
  private botId = '';
  private participantJoinCallbacks: Array<(participant: Participant) => void> = [];
  private participantLeaveCallbacks: Array<(participantId: string) => void> = [];
  private chatMessageCallbacks: Array<(message: ChatMessage) => void> = [];

  constructor(
    config: BrowserAdapterConfig,
    hooks: BrowserPlatformHooks<P, C>,
  ) {
    this.config = config;
    this.hooks = hooks;
    this.platform = hooks.platform;
  }

  async join(meetingUrl: string, botConfig: BotConfig): Promise<void> {
    const joinTimeout =
      this.config.joinTimeout ?? botConfig.joinTimeout ?? 30_000;
    this.botId = (botConfig as InternalBotConfig).__botId ?? this.botId;

    this.session = await createManagedBrowserSession(
      this.config,
      meetingUrl,
      joinTimeout,
      this.hooks.createSession,
    );

    await this.hooks.joinMeeting(this.session.page, joinTimeout);

    this.connected = true;
    this.participantTracker = this.hooks.createParticipantTracker(
      this.session.page,
      this.botId,
    );
    this.participantTracker.setBotId?.(this.botId);
    this.chatTracker = this.hooks.createChatTracker(this.session.page);

    for (const cb of this.participantJoinCallbacks) {
      this.participantTracker.onJoin(cb);
    }
    for (const cb of this.participantLeaveCallbacks) {
      this.participantTracker.onLeave(cb);
    }
    for (const cb of this.chatMessageCallbacks) {
      this.chatTracker.onMessage(cb);
    }

    await this.participantTracker.startObserving();
    await this.chatTracker.startObserving();
  }

  async leave(): Promise<void> {
    this.participantTracker?.stopObserving();
    this.chatTracker?.stopObserving();

    if (this.session) {
      await this.hooks.leaveMeeting(this.session.page);
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

    return this.hooks.createAudioStream(this.session.page);
  }

  async getParticipants(): Promise<Participant[]> {
    return this.participantTracker?.getAll() ?? [];
  }

  onParticipantJoin(cb: (participant: Participant) => void): void {
    this.participantJoinCallbacks.push(cb);
    this.participantTracker?.onJoin(cb);
  }

  onParticipantLeave(cb: (participantId: string) => void): void {
    this.participantLeaveCallbacks.push(cb);
    this.participantTracker?.onLeave(cb);
  }

  async getChatMessages(): Promise<ChatMessage[]> {
    return this.chatTracker?.getMessages() ?? [];
  }

  onChatMessage(cb: (message: ChatMessage) => void): void {
    this.chatMessageCallbacks.push(cb);
    this.chatTracker?.onMessage(cb);
  }

  async sendChatMessage(text: string): Promise<void> {
    await this.chatTracker?.send(text);
  }

  async getMetadata(): Promise<MeetingMetadata> {
    let title = this.hooks.defaultTitle;
    if (this.session) {
      try {
        title = (await this.session.page.title()) ?? title;
      } catch {
        // Ignore: title access is best effort.
      }
    }

    return {
      id: this.hooks.metadataId,
      botId: this.botId,
      title,
      platform: this.platform,
      chatMessages: this.chatTracker?.getMessages() ?? [],
    };
  }

  isConnected(): boolean {
    return this.connected;
  }
}
