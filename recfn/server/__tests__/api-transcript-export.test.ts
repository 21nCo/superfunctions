import { describe, it, expect, beforeEach } from 'vitest';
import { createTestServer, req, json } from './helpers.js';
import type { RecFnServer } from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';

describe('Transcript export formats (TV-TRX-005, TV-EXP-001, TV-EXP-002, TV-EXP-003)', () => {
  let server: RecFnServer;
  let store: RecFnStore;

  beforeEach(async () => {
    ({ server, store } = createTestServer());
  });

  async function createBotWithRecordingAndTranscript() {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'RecFn Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000,
        consentMessage: 'This meeting is being recorded',
        enableRealTimeTranscript: false,
        asrProvider: 'whisper',
        recordingFormat: 'mp4',
        language: 'en-US',
      },
      namespace: 'ns_test',
    });

    await store.createRecording(
      {
        id: 'rec_xyz789',
        botId: bot.id,
        format: 'mp4',
        duration: 60000,
        storageRef: 'recordings/ns_test/rec_xyz789.mp4',
        size: 1024,
        createdAt: '2026-02-28T15:00:00Z',
      },
      'ns_test',
    );

    await store.createTranscript(
      {
        id: 'trx_abc456',
        recordingId: 'rec_xyz789',
        language: 'en-US',
        status: 'ready',
        segments: [
          {
            speakerId: 'participant_1',
            startTime: 5000,
            endTime: 7000,
            text: "Hello everyone, let's get started.",
            confidence: 0.96,
          },
          {
            speakerId: 'participant_2',
            startTime: 7500,
            endTime: 9000,
            text: 'Sounds good. I have the agenda here.',
            confidence: 0.93,
          },
        ],
        createdAt: '2026-02-28T15:05:00Z',
      },
      'ns_test',
    );

    return { bot };
  }

  it('default format is json (TV-TRX-005)', async () => {
    await createBotWithRecordingAndTranscript();

    const res = await server.router.handle(
      req('GET', '/api/v1/recordings/rec_xyz789/transcript'),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data.segments).toHaveLength(2);
  });

  it('format=json returns Transcript with envelope and application/json', async () => {
    await createBotWithRecordingAndTranscript();

    const res = await server.router.handle(
      req('GET', '/api/v1/recordings/rec_xyz789/transcript?format=json'),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = await json(res);
    expect(body.ok).toBe(true);
    const data = body.data as { id: string; segments: Array<{ speakerId: string; text: string }> };
    expect(data.id).toBe('trx_abc456');
    expect(data.segments[0].text).toBe("Hello everyone, let's get started.");
  });

  it('format=srt produces valid SRT with Content-Type text/plain (TV-EXP-001)', async () => {
    await createBotWithRecordingAndTranscript();

    const res = await server.router.handle(
      req('GET', '/api/v1/recordings/rec_xyz789/transcript?format=srt'),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    const body = await res.text();
    expect(body).toContain('1\n00:00:05,000 --> 00:00:07,000');
    expect(body).toContain("[participant_1] Hello everyone, let's get started.");
    expect(body).toContain('2\n00:00:07,500 --> 00:00:09,000');
    expect(body).toContain('[participant_2] Sounds good. I have the agenda here.');
  });

  it('format=vtt produces valid WebVTT with Content-Type text/vtt (TV-EXP-002)', async () => {
    await createBotWithRecordingAndTranscript();

    const res = await server.router.handle(
      req('GET', '/api/v1/recordings/rec_xyz789/transcript?format=vtt'),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/vtt');
    const body = await res.text();
    expect(body).toContain('WEBVTT');
    expect(body).toContain('00:00:05.000 --> 00:00:07.000');
    expect(body).toContain("<v participant_1>Hello everyone, let's get started.");
    expect(body).toContain('00:00:07.500 --> 00:00:09.000');
    expect(body).toContain('<v participant_2>Sounds good. I have the agenda here.');
  });

  it('format=text produces plain text with Content-Type text/plain', async () => {
    await createBotWithRecordingAndTranscript();

    const res = await server.router.handle(
      req('GET', '/api/v1/recordings/rec_xyz789/transcript?format=text'),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    const body = await res.text();
    expect(body).toContain("[participant_1] (00:00:05): Hello everyone, let's get started.");
    expect(body).toContain('[participant_2] (00:00:07): Sounds good. I have the agenda here.');
  });

  it('redact=true replaces participant names with [REDACTED] (TV-TRX-008, TV-EXP-003)', async () => {
    const { bot } = await createBotWithRecordingAndTranscript();

    await store.addParticipant(
      bot.id,
      {
        id: 'participant_1',
        botId: bot.id,
        name: 'John Smith',
        email: 'john@example.com',
        role: 'host',
        joinedAt: '2026-02-28T14:00:00Z',
        leftAt: '2026-02-28T15:00:00Z',
        consent: 'granted',
      },
      'ns_test',
    );
    await store.addParticipant(
      bot.id,
      {
        id: 'participant_2',
        botId: bot.id,
        name: 'Jane Doe',
        role: 'attendee',
        joinedAt: '2026-02-28T14:01:00Z',
        leftAt: '2026-02-28T14:50:00Z',
        consent: 'unknown',
      },
      'ns_test',
    );

    const res = await server.router.handle(
      req('GET', '/api/v1/recordings/rec_xyz789/transcript?format=text&redact=true'),
    );

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('[REDACTED]');
    expect(body).not.toContain('John Smith');
    expect(body).not.toContain('Jane Doe');
    expect(body).not.toContain('john@example.com');
  });

  it('redact=true redacts names in segment text', async () => {
    const { bot } = await createBotWithRecordingAndTranscript();

    await store.updateTranscript('trx_abc456', 'ns_test', {
      segments: [
        {
          speakerId: 'participant_1',
          startTime: 5000,
          endTime: 7000,
          text: 'John Smith said hello to Jane Doe.',
          confidence: 0.96,
        },
        {
          speakerId: 'participant_2',
          startTime: 7500,
          endTime: 9000,
          text: 'Thanks John.',
          confidence: 0.93,
        },
      ],
    });

    await store.addParticipant(
      bot.id,
      {
        id: 'participant_1',
        botId: bot.id,
        name: 'John Smith',
        role: 'host',
        joinedAt: '2026-02-28T14:00:00Z',
        consent: 'granted',
      },
      'ns_test',
    );
    await store.addParticipant(
      bot.id,
      {
        id: 'participant_2',
        botId: bot.id,
        name: 'Jane Doe',
        role: 'attendee',
        joinedAt: '2026-02-28T14:01:00Z',
        consent: 'unknown',
      },
      'ns_test',
    );

    const res = await server.router.handle(
      req('GET', '/api/v1/recordings/rec_xyz789/transcript?format=text&redact=true'),
    );

    expect(res.status).toBe(200);
    const body = await res.text();
    // John Smith and Jane Doe (full names) are redacted in segment text
    expect(body).toContain('[REDACTED] said hello to [REDACTED]');
    expect(body).not.toContain('John Smith');
    expect(body).not.toContain('Jane Doe');
    // Speaker labels (participant names) are redacted
    expect(body).toContain('[REDACTED]');
    // "Thanks John." - "John" alone is not a participant name, so it stays
    expect(body).toContain('Thanks John.');
  });

  it('invalid format falls back to json', async () => {
    await createBotWithRecordingAndTranscript();

    const res = await server.router.handle(
      req('GET', '/api/v1/recordings/rec_xyz789/transcript?format=invalid'),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = await json(res);
    expect(body.ok).toBe(true);
  });
});
