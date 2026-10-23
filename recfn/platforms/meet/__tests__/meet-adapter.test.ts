import { createMeetChatTracker } from '../src/chat.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeetAdapter } from '../src/index.js';
import type { Page } from 'playwright';

function createMockPage(evaluateResults: unknown[] = []): Page {
  const queuedResults = [...evaluateResults];
  const evaluate = vi.fn(async () => {
    if (queuedResults.length === 0) {
      return [];
    }
    return queuedResults.shift();
  });
  const waitForSelector = vi.fn().mockRejectedValue(new Error('timeout'));
  const waitForTimeout = vi.fn().mockResolvedValue(undefined);
  const waitForFunction = vi.fn().mockResolvedValue(undefined);
  const $ = vi.fn().mockResolvedValue({ fill: vi.fn().mockResolvedValue(undefined) });
  const title = vi.fn().mockResolvedValue('Test Meeting - Google Meet');
  const keyboard = { press: vi.fn().mockResolvedValue(undefined) };
  const getByRole = vi.fn(() => ({
    click: vi.fn().mockResolvedValue(undefined),
  }));

  return {
    evaluate,
    waitForSelector,
    waitForTimeout,
    waitForFunction,
    $,
    title,
    keyboard,
    getByRole,
    goto: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

describe('MeetAdapter (TV-PLAT-002, PLAT-003)', () => {
  let mockPage: Page;
  let adapter: MeetAdapter;

  beforeEach(() => {
    mockPage = createMockPage([false, { ok: true, waiting: true }, [], true, []]);
    adapter = new MeetAdapter({ testPage: mockPage });
  });

  it('reports platform as "meet"', () => {
    expect(adapter.platform).toBe('meet');
  });

  it('implements PlatformAdapter interface', () => {
    expect(typeof adapter.join).toBe('function');
    expect(typeof adapter.leave).toBe('function');
    expect(typeof adapter.getAudioStream).toBe('function');
    expect(typeof adapter.getParticipants).toBe('function');
    expect(typeof adapter.onParticipantJoin).toBe('function');
    expect(typeof adapter.onParticipantLeave).toBe('function');
    expect(typeof adapter.getChatMessages).toBe('function');
    expect(typeof adapter.onChatMessage).toBe('function');
    expect(typeof adapter.sendChatMessage).toBe('function');
    expect(typeof adapter.getMetadata).toBe('function');
    expect(typeof adapter.isConnected).toBe('function');
  });

  it('join navigates and initializes trackers', async () => {
    await adapter.join('https://meet.google.com/abc-defg-hij', {
      displayName: 'RecFn Bot',
      joinTimeout: 30000,
      autoLeaveOnEmpty: true,
      autoLeaveEmptyTimeout: 30000,
      consentMessage: 'This meeting is being recorded',
      enableRealTimeTranscript: false,
      asrProvider: 'whisper',
      recordingFormat: 'mp4',
      language: 'en-US',
    });

    expect(adapter.isConnected()).toBe(true);
    const participants = await adapter.getParticipants();
    expect(Array.isArray(participants)).toBe(true);
  });

  it('getAudioStream yields non-empty audio chunks when prerequisites are satisfied', async () => {
    mockPage = createMockPage([
      false,
      { ok: true, waiting: true },
      [],
      true,
      [],
      {
        ok: true,
        sessionId: 'capture_session',
        sampleRate: 48000,
        channels: 1,
      },
      {
        chunks: [[1, 2, 3, 4]],
        done: true,
        error: null,
        sampleRate: 48000,
        channels: 1,
      },
    ]);
    adapter = new MeetAdapter({ testPage: mockPage });

    await adapter.join('https://meet.google.com/abc-defg-hij', {
      displayName: 'Bot',
      joinTimeout: 30000,
      autoLeaveOnEmpty: true,
      autoLeaveEmptyTimeout: 30000,
      consentMessage: 'Recording',
      enableRealTimeTranscript: false,
      asrProvider: 'whisper',
      recordingFormat: 'mp4',
      language: 'en-US',
    });

    const stream = adapter.getAudioStream();
    expect(stream).toBeInstanceOf(ReadableStream);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(Array.from(first.value!.data)).toEqual([1, 2, 3, 4]);
    expect(first.value!.data.byteLength).toBeGreaterThan(0);
  });

  it('fails with PLATFORM_CAPTURE_UNAVAILABLE when Meet capture prerequisites are missing', async () => {
    mockPage = createMockPage([
      false,
      { ok: true, waiting: true },
      [],
      true,
      [],
      {
        ok: false,
        reason: 'Meet audio capture requires display-media capture support in this browser runtime.',
        details: { missingCapabilities: ['getDisplayMedia'] },
      },
    ]);
    adapter = new MeetAdapter({ testPage: mockPage });

    await adapter.join('https://meet.google.com/abc-defg-hij', {
      displayName: 'Bot',
      joinTimeout: 30000,
      autoLeaveOnEmpty: true,
      autoLeaveEmptyTimeout: 30000,
      consentMessage: 'Recording',
      enableRealTimeTranscript: false,
      asrProvider: 'whisper',
      recordingFormat: 'mp4',
      language: 'en-US',
    });

    const stream = adapter.getAudioStream();
    const reader = stream.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      code: 'PLATFORM_CAPTURE_UNAVAILABLE',
    });
  });

  it('getMetadata returns MeetingMetadata', async () => {
    await adapter.join('https://meet.google.com/abc-defg-hij', {
      displayName: 'Bot',
      joinTimeout: 30000,
      autoLeaveOnEmpty: true,
      autoLeaveEmptyTimeout: 30000,
      consentMessage: 'Recording',
      enableRealTimeTranscript: false,
      asrProvider: 'whisper',
      recordingFormat: 'mp4',
      language: 'en-US',
    });

    const meta = await adapter.getMetadata();
    expect(meta.platform).toBe('meet');
    expect(meta.chatMessages).toBeDefined();
    expect(Array.isArray(meta.chatMessages)).toBe(true);
  });

  it('leave disconnects and cleans up', async () => {
    await adapter.join('https://meet.google.com/abc-defg-hij', {
      displayName: 'Bot',
      joinTimeout: 30000,
      autoLeaveOnEmpty: true,
      autoLeaveEmptyTimeout: 30000,
      consentMessage: 'Recording',
      enableRealTimeTranscript: false,
      asrProvider: 'whisper',
      recordingFormat: 'mp4',
      language: 'en-US',
    });

    expect(adapter.isConnected()).toBe(true);
    await adapter.leave();
    expect(adapter.isConnected()).toBe(false);
  });

  it('rejects chat sends before a session exists', async () => {
    await expect(adapter.sendChatMessage('Recording')).rejects.toThrow('Chat is unavailable');
  });

  it('sendChatMessage does not throw when chat tracker exists', async () => {
    await adapter.join('https://meet.google.com/abc-defg-hij', {
      displayName: 'Bot',
      joinTimeout: 30000,
      autoLeaveOnEmpty: true,
      autoLeaveEmptyTimeout: 30000,
      consentMessage: 'Recording',
      enableRealTimeTranscript: false,
      asrProvider: 'whisper',
      recordingFormat: 'mp4',
      language: 'en-US',
    });

    await expect(adapter.sendChatMessage('Hello')).resolves.not.toThrow();
  });

  it('onParticipantJoin registers callback before join', async () => {
    const joined: string[] = [];
    adapter.onParticipantJoin((p) => joined.push(p.name));

    await adapter.join('https://meet.google.com/abc-defg-hij', {
      displayName: 'Bot',
      joinTimeout: 30000,
      autoLeaveOnEmpty: true,
      autoLeaveEmptyTimeout: 30000,
      consentMessage: 'Recording',
      enableRealTimeTranscript: false,
      asrProvider: 'whisper',
      recordingFormat: 'mp4',
      language: 'en-US',
    });

    expect(joined).toBeDefined();
  });
});


describe('chat send failure reporting', () => {
  it('rejects missing chat input instead of claiming a send', async () => {
    const page = createMockPage();
    vi.mocked(page.$).mockResolvedValue(null);
    await expect(createMeetChatTracker(page).send('Recording')).rejects.toThrow('chat input unavailable');
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });
  it('preserves send failures instead of claiming a send', async () => {
    const page = createMockPage();
    const failure = new Error('chat send rejected');
    vi.mocked(page.keyboard.press).mockRejectedValue(failure);
    await expect(createMeetChatTracker(page).send('Recording')).rejects.toBe(failure);
  });
});
