import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioChunk, BotConfig, ChatMessage, MeetingMetadata, Participant } from '@recfn/core';
import type { Browser, Page } from 'playwright';
import {
  BrowserAutomationAdapter,
  createBrowserAudioStream,
  createBrowserChatTracker,
  createBrowserParticipantTracker,
  createBrowserSession,
  joinBrowserMeeting,
  leaveBrowserMeeting,
} from '../src/index.js';

function createMockPage(): Page {
  return {
    evaluate: vi.fn(),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue('Shared Browser Meeting'),
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
    },
    $: vi.fn().mockResolvedValue({
      fill: vi.fn().mockResolvedValue(undefined),
    }),
    goto: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

describe('browser-core session helpers', () => {
  it('createBrowserSession bootstraps a page with microphone and camera permissions', async () => {
    const page = createMockPage();
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
    } as unknown as Browser;

    const session = await createBrowserSession(
      {
        browser,
        userDataDir: '/tmp/recfn-browser-core-test',
        joinTimeout: 12_345,
      },
      'https://example.test/meeting',
    );

    expect(browser.newContext).toHaveBeenCalledWith({
      permissions: ['microphone', 'camera'],
    });
    expect(page.goto).toHaveBeenCalledWith('https://example.test/meeting', {
      waitUntil: 'domcontentloaded',
      timeout: 12_345,
    });

    await session.close();
    expect(context.close).toHaveBeenCalled();
  });

  it('joinBrowserMeeting shares join click, fallback wait, and settle delay behavior', async () => {
    const page = createMockPage();
    const clickJoin = vi.fn().mockResolvedValue(false);

    await joinBrowserMeeting(page, {
      clickJoin,
      readySelector: '[data-meeting-ready]',
      joinTimeout: 30_000,
      settleDelayMs: 250,
    });

    expect(clickJoin).toHaveBeenCalledWith(page);
    expect(page.waitForSelector).toHaveBeenCalledWith('[data-meeting-ready]', {
      timeout: 15_000,
    });
    expect(page.waitForTimeout).toHaveBeenCalledWith(250);
  });

  it('leaveBrowserMeeting shares leave click and settle delay behavior', async () => {
    const page = createMockPage();
    const clickLeave = vi.fn().mockResolvedValue(undefined);

    await leaveBrowserMeeting(page, clickLeave, 400);

    expect(clickLeave).toHaveBeenCalledWith(page);
    expect(page.waitForTimeout).toHaveBeenCalledWith(400);
  });
});

describe('browser-core trackers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('createBrowserParticipantTracker polls, emits joins, and preserves bot ownership', async () => {
    const page = createMockPage();
    vi.mocked(page.evaluate)
      .mockResolvedValueOnce([{ id: 'p_1', name: 'Alice' }])
      .mockResolvedValueOnce([
        { id: 'p_1', name: 'Alice' },
        { id: 'p_2', name: 'Bob' },
      ]);

    const tracker = createBrowserParticipantTracker({
      page,
      botId: 'bot_123',
      pollIntervalMs: 50,
      evaluateParticipants: () => [],
    });
    const joined: Participant[] = [];
    tracker.onJoin((participant) => joined.push(participant));

    await tracker.startObserving();
    await vi.advanceTimersByTimeAsync(55);

    expect(joined.map((participant) => participant.id)).toEqual(['p_1', 'p_2']);
    expect(joined.every((participant) => participant.botId === 'bot_123')).toBe(true);

    tracker.stopObserving();
    vi.useRealTimers();
  });

  it('createBrowserChatTracker polls, deduplicates, and shares send behavior', async () => {
    const page = createMockPage();
    vi.mocked(page.evaluate)
      .mockResolvedValueOnce([
        { participantId: 'alice', text: 'Hello', timestamp: '2026-04-01T00:00:00.000Z' },
      ])
      .mockResolvedValueOnce([
        { participantId: 'alice', text: 'Hello', timestamp: '2026-04-01T00:00:00.000Z' },
        { participantId: 'bob', text: 'Hi', timestamp: '2026-04-01T00:00:01.000Z' },
      ]);

    const tracker = createBrowserChatTracker({
      page,
      pollIntervalMs: 50,
      evaluateMessages: () => [],
      sendMessage: async (currentPage, text) => {
        const input = await currentPage.$('[data-chat-input]');
        if (input) {
          await input.fill(text);
          await currentPage.keyboard.press('Enter');
        }
      },
    });
    const messages: ChatMessage[] = [];
    tracker.onMessage((message) => messages.push(message));

    await tracker.startObserving();
    await vi.advanceTimersByTimeAsync(55);
    await tracker.send('Shared message');

    expect(messages.map((message) => message.text)).toEqual(['Hello', 'Hi']);
    expect(page.$).toHaveBeenCalledWith('[data-chat-input]');
    expect(page.keyboard.press).toHaveBeenCalledWith('Enter');

    tracker.stopObserving();
    vi.useRealTimers();
  });

  it('createBrowserAudioStream shares support detection and chunk lifecycle', async () => {
    const page = createMockPage();
    vi.mocked(page.evaluate).mockResolvedValue({
      supported: true,
      sampleRate: 44_100,
      channels: 2,
    });

    const stream = createBrowserAudioStream(page, () => ({ supported: true }));
    const reader = stream.getReader();
    const { value, done } = await reader.read();

    expect(done).toBe(false);
    expect(value).toEqual<AudioChunk>({
      data: new Uint8Array(0),
      timestamp: expect.any(Number),
      sampleRate: 44_100,
      channels: 2,
    });

    const next = await reader.read();
    expect(next.done).toBe(true);
  });
});

describe('BrowserAutomationAdapter', () => {
  let page: Page;
  let adapter: BrowserAutomationAdapter<
    ReturnType<typeof createBrowserParticipantTracker>,
    ReturnType<typeof createBrowserChatTracker>
  >;

  beforeEach(() => {
    page = createMockPage();
    vi.mocked(page.evaluate)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce([{ id: 'p_1', name: 'Alice' }])
      .mockResolvedValueOnce([
        { participantId: 'alice', text: 'Hello', timestamp: '2026-04-01T00:00:00.000Z' },
      ]);

    adapter = new BrowserAutomationAdapter(
      { testPage: page },
      {
        platform: 'meet',
        metadataId: 'meet',
        defaultTitle: 'Google Meet',
        createSession: vi.fn(),
        joinMeeting: async (currentPage, joinTimeout) => {
          await joinBrowserMeeting(currentPage, {
            clickJoin: async (joinPage) =>
              joinPage.evaluate(() => false as boolean),
            readySelector: '[data-ready]',
            joinTimeout,
          });
        },
        leaveMeeting: async (currentPage) => {
          await leaveBrowserMeeting(currentPage, async () => undefined);
        },
        createParticipantTracker: (currentPage, botId) =>
          createBrowserParticipantTracker({
            page: currentPage,
            botId,
            evaluateParticipants: () => [],
          }),
        createChatTracker: (currentPage) =>
          createBrowserChatTracker({
            page: currentPage,
            evaluateMessages: () => [],
            sendMessage: async () => undefined,
          }),
        createAudioStream: (currentPage) =>
          createBrowserAudioStream(currentPage, () => ({ supported: true })),
      },
    );
  });

  it('shares adapter lifecycle across browser platforms without changing the public API', async () => {
    const joined: Participant[] = [];
    const chats: ChatMessage[] = [];
    adapter.onParticipantJoin((participant) => joined.push(participant));
    adapter.onChatMessage((message) => chats.push(message));

    await adapter.join('https://example.test/meeting', {
      __botId: 'bot_789',
    } as BotConfig & { __botId: string });

    expect(adapter.platform).toBe('meet');
    expect(adapter.isConnected()).toBe(true);
    expect((await adapter.getParticipants())[0]?.botId).toBe('bot_789');
    expect((await adapter.getChatMessages())[0]?.text).toBe('Hello');

    const metadata = await adapter.getMetadata();
    expect(metadata).toEqual<MeetingMetadata>({
      id: 'meet',
      botId: 'bot_789',
      title: 'Shared Browser Meeting',
      platform: 'meet',
      chatMessages: chats,
    });

    await adapter.leave();
    expect(adapter.isConnected()).toBe(false);
    expect(joined).toHaveLength(1);
  });
});
