import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZoomAdapter } from '../src/index.js';
import type {
  ZoomMeetingSdk,
  ZoomMeetingSdkConfig,
  ZoomParticipantInfo,
  ZoomChatMessageInfo,
  ZoomAudioFrame,
  ZoomVideoFrame,
} from '../src/meeting-sdk.js';
import { parseMeetingUrl } from '../src/meeting-sdk.js';

type EventMap = {
  'audio-frame': (frame: ZoomAudioFrame) => void;
  'participant-audio-frame': (frame: ZoomAudioFrame) => void;
  'video-frame': (frame: ZoomVideoFrame) => void;
  'participant-joined': (info: ZoomParticipantInfo) => void;
  'participant-left': (info: { participantId: string }) => void;
  'chat-message': (msg: ZoomChatMessageInfo) => void;
  'meeting-ended': () => void;
};

function createMockSdk(): ZoomMeetingSdk & {
  emit<K extends keyof EventMap>(event: K, ...args: Parameters<EventMap[K]>): void;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  return {
    init: vi.fn(async () => {}),
    join: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
    getMeetingInfo: vi.fn(() => ({
      meetingNumber: '1234567890',
      meetingTopic: 'Test Meeting',
      hostName: 'Host User',
    })),
    getParticipants: vi.fn(() => [
      {
        participantId: 'p1',
        name: 'Alice',
        email: 'alice@example.com',
        isHost: true,
      },
      {
        participantId: 'p2',
        name: 'Bob',
        email: undefined,
        isHost: false,
      },
    ]),
    sendChat: vi.fn(async () => {}),
    startRawAudio: vi.fn(),
    stopRawAudio: vi.fn(),
    startRawVideo: vi.fn(),
    stopRawVideo: vi.fn(),
    isInMeeting: vi.fn(() => true),
    on(event: string, cb: (...args: unknown[]) => void) {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event)!.push(cb);
    },
    off(event: string, cb: (...args: unknown[]) => void) {
      const cbs = listeners.get(event);
      if (cbs) {
        const idx = cbs.indexOf(cb);
        if (idx >= 0) cbs.splice(idx, 1);
      }
    },
    emit(event: string, ...args: unknown[]) {
      const cbs = listeners.get(event) ?? [];
      for (const cb of cbs) {
        cb(...args);
      }
    },
  };
}

const SDK_CONFIG: ZoomMeetingSdkConfig = {
  sdkKey: 'test-sdk-key',
  sdkSecret: 'test-sdk-secret',
};

describe('parseMeetingUrl', () => {
  it('extracts meeting number and password from standard Zoom URL', () => {
    const result = parseMeetingUrl(
      'https://zoom.us/j/1234567890?pwd=abc123',
    );
    expect(result.meetingNumber).toBe('1234567890');
    expect(result.password).toBe('abc123');
  });

  it('extracts meeting number without password', () => {
    const result = parseMeetingUrl('https://zoom.us/j/9876543210');
    expect(result.meetingNumber).toBe('9876543210');
    expect(result.password).toBeUndefined();
  });

  it('handles subdomain Zoom URLs', () => {
    const result = parseMeetingUrl(
      'https://company.zoom.us/j/5555555555?pwd=xyz',
    );
    expect(result.meetingNumber).toBe('5555555555');
    expect(result.password).toBe('xyz');
  });
});

describe('ZoomAdapter', () => {
  let sdk: ReturnType<typeof createMockSdk>;
  let adapter: ZoomAdapter;

  beforeEach(() => {
    sdk = createMockSdk();
    adapter = new ZoomAdapter({ sdk, sdkConfig: SDK_CONFIG });
  });

  describe('platform', () => {
    it('reports platform as "zoom"', () => {
      expect(adapter.platform).toBe('zoom');
    });
  });

  describe('join', () => {
    it('initializes SDK and joins meeting', async () => {
      await adapter.join('https://zoom.us/j/1234567890?pwd=abc', {
        displayName: 'Test Bot',
      });

      expect(sdk.init).toHaveBeenCalledWith(SDK_CONFIG);
      expect(sdk.join).toHaveBeenCalledWith({
        meetingNumber: '1234567890',
        password: 'abc',
        displayName: 'Test Bot',
      });
      expect(sdk.startRawAudio).toHaveBeenCalled();
      expect(sdk.startRawVideo).toHaveBeenCalled();
      expect(adapter.isConnected()).toBe(true);
    });

    it('uses default display name when not provided', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {});

      expect(sdk.join).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'RecFn Bot' }),
      );
    });
  });

  describe('leave', () => {
    it('stops capture and leaves meeting', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {});
      await adapter.leave();

      expect(sdk.stopRawAudio).toHaveBeenCalled();
      expect(sdk.stopRawVideo).toHaveBeenCalled();
      expect(sdk.leave).toHaveBeenCalled();
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('is false before join', () => {
      expect(adapter.isConnected()).toBe(false);
    });

    it('is true after join', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {});
      expect(adapter.isConnected()).toBe(true);
    });

    it('becomes false when meeting ends', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {});
      sdk.emit('meeting-ended');
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe('getAudioStream', () => {
    it('returns a ReadableStream that receives audio chunks', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {});
      const stream = adapter.getAudioStream();
      const reader = stream.getReader();

      const frame: ZoomAudioFrame = {
        buffer: new Uint8Array([1, 2, 3]),
        sampleRate: 48000,
        channels: 1,
      };
      sdk.emit('audio-frame', frame);

      const { value, done } = await reader.read();
      expect(done).toBe(false);
      expect(value).toBeDefined();
      expect(value!.data).toEqual(new Uint8Array([1, 2, 3]));
      expect(value!.sampleRate).toBe(48000);
      expect(value!.channels).toBe(1);
      expect(value!.timestamp).toBeTypeOf('number');

      reader.releaseLock();
    });
  });

  describe('getVideoStream', () => {
    it('returns a ReadableStream that receives video chunks', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {});
      const stream = adapter.getVideoStream!();
      const reader = stream.getReader();

      const frame: ZoomVideoFrame = {
        buffer: new Uint8Array([10, 20, 30]),
        width: 1920,
        height: 1080,
      };
      sdk.emit('video-frame', frame);

      const { value, done } = await reader.read();
      expect(done).toBe(false);
      expect(value).toBeDefined();
      expect(value!.data).toEqual(new Uint8Array([10, 20, 30]));
      expect(value!.width).toBe(1920);
      expect(value!.height).toBe(1080);

      reader.releaseLock();
    });
  });

  describe('participant tracking', () => {
    it('tracks participants via SDK events', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {
        __botId: 'bot_zoom_1',
      } as { __botId: string });

      const joinedParticipants: Array<{ id: string; name: string }> = [];
      adapter.onParticipantJoin((p) =>
        joinedParticipants.push({ id: p.id, name: p.name }),
      );

      sdk.emit('participant-joined', {
        participantId: 'p1',
        name: 'Alice',
        email: 'alice@example.com',
        isHost: true,
      });

      expect(joinedParticipants).toHaveLength(1);
      expect(joinedParticipants[0].id).toBe('p1');
      expect(joinedParticipants[0].name).toBe('Alice');

      const all = await adapter.getParticipants();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('Alice');
      expect(all[0].email).toBe('alice@example.com');
      expect(all[0].botId).toBe('bot_zoom_1');
      expect(all[0].role).toBe('host');
      expect(all[0].consent).toBe('pending');
      expect(all[0].joinedAt).toBeDefined();
    });

    it('tracks participant leave events', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {});

      const leftIds: string[] = [];
      adapter.onParticipantLeave((id) => leftIds.push(id));

      sdk.emit('participant-joined', {
        participantId: 'p1',
        name: 'Alice',
        email: undefined,
        isHost: false,
      });

      sdk.emit('participant-left', { participantId: 'p1' });

      expect(leftIds).toEqual(['p1']);

      const all = await adapter.getParticipants();
      expect(all[0].leftAt).toBeDefined();
    });

    it('snapshots SDK participants when no tracked participants', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {
        __botId: 'bot_zoom_snapshot',
      } as { __botId: string });
      // Before any join/leave events, getParticipants falls back to SDK snapshot
      const participants = await adapter.getParticipants();
      expect(participants).toHaveLength(2);
      expect(participants[0].name).toBe('Alice');
      expect(participants[0].botId).toBe('bot_zoom_snapshot');
      expect(participants[0].role).toBe('host');
      expect(participants[1].name).toBe('Bob');
      expect(participants[1].role).toBe('attendee');
    });
  });

  describe('chat', () => {
    it('captures incoming chat messages', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {});

      const captured: Array<{ text: string }> = [];
      adapter.onChatMessage((msg) => captured.push({ text: msg.text }));

      sdk.emit('chat-message', {
        senderId: 'p1',
        senderName: 'Alice',
        message: 'Hello everyone!',
        timestamp: 1709136000000,
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].text).toBe('Hello everyone!');

      const messages = await adapter.getChatMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].participantId).toBe('p1');
      expect(messages[0].text).toBe('Hello everyone!');
      expect(messages[0].timestamp).toBeDefined();
    });

    it('sends chat messages via SDK', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {});
      await adapter.sendChatMessage('This meeting is being recorded');

      expect(sdk.sendChat).toHaveBeenCalledWith(
        'This meeting is being recorded',
      );
    });

    it('sends consent message via sendChatMessage', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {});
      const consentText = 'Recording in progress for compliance.';
      await adapter.sendChatMessage(consentText);

      expect(sdk.sendChat).toHaveBeenCalledWith(consentText);
    });
  });

  describe('getMetadata', () => {
    it('returns meeting metadata from SDK', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {
        __botId: 'bot_zoom_meta',
      } as { __botId: string });
      const metadata = await adapter.getMetadata();

      expect(metadata.id).toBe('1234567890');
      expect(metadata.botId).toBe('bot_zoom_meta');
      expect(metadata.title).toBe('Test Meeting');
      expect(metadata.startTime).toBeDefined();
      expect(metadata.platform).toBe('zoom');
      expect(metadata.chatMessages).toEqual([]);
    });

    it('sets metadata endTime after leave', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {
        __botId: 'bot_zoom_meta_end',
      } as { __botId: string });
      await adapter.leave();

      const metadata = await adapter.getMetadata();
      expect(metadata.botId).toBe('bot_zoom_meta_end');
      expect(metadata.endTime).toBeDefined();
    });

    it('includes captured chat messages in metadata', async () => {
      await adapter.join('https://zoom.us/j/1234567890', {});

      sdk.emit('chat-message', {
        senderId: 'p1',
        senderName: 'Alice',
        message: 'Test message',
        timestamp: Date.now(),
      });

      const metadata = await adapter.getMetadata();
      expect(metadata.chatMessages).toHaveLength(1);
      expect(metadata.chatMessages[0].text).toBe('Test message');
    });
  });

  describe('PlatformAdapter interface conformance', () => {
    it('implements all required PlatformAdapter methods', () => {
      expect(adapter.platform).toBe('zoom');
      expect(typeof adapter.join).toBe('function');
      expect(typeof adapter.leave).toBe('function');
      expect(typeof adapter.getAudioStream).toBe('function');
      expect(typeof adapter.getVideoStream).toBe('function');
      expect(typeof adapter.getParticipants).toBe('function');
      expect(typeof adapter.onParticipantJoin).toBe('function');
      expect(typeof adapter.onParticipantLeave).toBe('function');
      expect(typeof adapter.getChatMessages).toBe('function');
      expect(typeof adapter.onChatMessage).toBe('function');
      expect(typeof adapter.sendChatMessage).toBe('function');
      expect(typeof adapter.getMetadata).toBe('function');
      expect(typeof adapter.isConnected).toBe('function');
    });
  });

  describe('full lifecycle', () => {
    it('join → capture audio → track participants → chat → leave', async () => {
      // Join
      await adapter.join('https://zoom.us/j/1234567890?pwd=abc', {
        displayName: 'RecFn',
      });
      expect(adapter.isConnected()).toBe(true);

      // Participant joins
      const joinedNames: string[] = [];
      adapter.onParticipantJoin((p) => joinedNames.push(p.name));
      sdk.emit('participant-joined', {
        participantId: 'p1',
        name: 'Alice',
        email: 'alice@test.com',
        isHost: true,
      });
      expect(joinedNames).toEqual(['Alice']);

      // Audio stream
      const audioStream = adapter.getAudioStream();
      const audioReader = audioStream.getReader();
      sdk.emit('audio-frame', {
        buffer: new Uint8Array([1]),
        sampleRate: 44100,
        channels: 2,
      });
      const audioResult = await audioReader.read();
      expect(audioResult.value!.sampleRate).toBe(44100);
      audioReader.releaseLock();

      // Chat message
      sdk.emit('chat-message', {
        senderId: 'p1',
        senderName: 'Alice',
        message: 'Hi',
        timestamp: Date.now(),
      });
      const messages = await adapter.getChatMessages();
      expect(messages).toHaveLength(1);

      // Send consent
      await adapter.sendChatMessage('This meeting is being recorded');
      expect(sdk.sendChat).toHaveBeenCalledWith(
        'This meeting is being recorded',
      );

      // Leave
      await adapter.leave();
      expect(adapter.isConnected()).toBe(false);
    });
  });
});
