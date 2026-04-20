import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatJson,
  formatBotList,
  formatBot,
  formatRecordingList,
  formatTranscriptSearch,
  formatAnalytics,
  formatCalendarList,
} from '../src/output.js';
import {
  DEFAULT_TRANSCRIPT_REDACTION_MESSAGE,
  runTranscriptGetCommand,
} from '../src/commands/transcript.js';

describe('output formatters', () => {
  describe('formatJson', () => {
    it('formats data as pretty-printed JSON', () => {
      const data = { id: 'b1', status: 'recording' };
      expect(formatJson(data)).toBe(JSON.stringify(data, null, 2));
    });

    it('formats primitives and arrays', () => {
      expect(formatJson([1, 2, 3])).toContain('1');
      expect(formatJson('hello')).toBe('"hello"');
    });
  });

  describe('formatBotList', () => {
    it('formats empty list', () => {
      expect(formatBotList({ bots: [] })).toBe('No bots found.');
    });

    it('formats bot list with headers', () => {
      const out = formatBotList({
        bots: [
          { id: 'b1', status: 'recording', platform: 'zoom' },
          { id: 'b2', status: 'joined', platform: 'meet' },
        ],
      });
      expect(out).toContain('ID');
      expect(out).toContain('Status');
      expect(out).toContain('Platform');
      expect(out).toContain('b1');
      expect(out).toContain('recording');
      expect(out).toContain('zoom');
    });
  });

  describe('formatBot', () => {
    it('formats bot details', () => {
      const out = formatBot({
        id: 'b1',
        status: 'recording',
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123',
      });
      expect(out).toContain('b1');
      expect(out).toContain('recording');
      expect(out).toContain('zoom');
      expect(out).toContain('https://zoom.us/j/123');
    });
  });

  describe('formatRecordingList', () => {
    it('formats empty list', () => {
      expect(formatRecordingList({ recordings: [] })).toBe('No recordings found.');
    });

    it('formats recording list', () => {
      const out = formatRecordingList({
        recordings: [
          { id: 'r1', format: 'mp4', duration: 60000 },
        ],
      });
      expect(out).toContain('r1');
      expect(out).toContain('mp4');
      expect(out).toContain('60');
    });
  });

  describe('formatTranscriptSearch', () => {
    it('formats empty results', () => {
      expect(formatTranscriptSearch({ results: [] })).toBe('No results found.');
    });

    it('formats search results', () => {
      const out = formatTranscriptSearch({
        results: [
          { recordingId: 'r1', botId: 'b1', segment: { text: 'Hello world' } },
        ],
      });
      expect(out).toContain('r1');
      expect(out).toContain('Hello');
    });
  });

  describe('formatAnalytics', () => {
    it('formats analytics data', () => {
      const out = formatAnalytics({
        recordingId: 'r1',
        totalDuration: 120000,
        talkTime: { p1: 60000, p2: 30000 },
        silencePercentage: 0.25,
      });
      expect(out).toContain('r1');
      expect(out).toContain('120');
      expect(out).toContain('25');
      expect(out).toContain('p1');
    });
  });

  describe('formatCalendarList', () => {
    it('formats empty list', () => {
      expect(formatCalendarList({ calendars: [] })).toBe('No calendars connected.');
    });

    it('formats calendar list', () => {
      const out = formatCalendarList({
        calendars: [{ id: 'c1', provider: 'google' }],
      });
      expect(out).toContain('c1');
      expect(out).toContain('google');
    });
  });
});

describe('config', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('loadConfig returns config when RECFN_API_KEY is set', async () => {
    process.env.RECFN_API_KEY = 'test-key-123';
    process.env.RECFN_SERVER_URL = 'https://api.example.com';
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.apiKey).toBe('test-key-123');
    expect(config.baseUrl).toBe('https://api.example.com');
  });

  it('loadConfig uses default baseUrl when RECFN_SERVER_URL not set', async () => {
    process.env.RECFN_API_KEY = 'test-key';
    delete process.env.RECFN_SERVER_URL;
    delete process.env.RECFN_BASE_URL;
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.baseUrl).toBe('http://localhost:3000');
  });

  it('loadConfig exits when RECFN_API_KEY is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit called');
    }) as () => never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      delete process.env.RECFN_API_KEY;
      const { loadConfig } = await import('../src/config.js');
      expect(() => loadConfig()).toThrow('exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});

describe('transcript command safety', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to redacted transcript retrieval and safe stdout text output (TV-CLI-001)', async () => {
    const getMock = vi.fn().mockResolvedValue({
      ok: true,
      data: '[REDACTED]: budget discussion',
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runTranscriptGetCommand(
      {
        transcripts: { get: getMock },
      } as never,
      'text',
      'rec_123',
      { format: 'text' },
    );

    expect(getMock).toHaveBeenCalledWith('rec_123', {
      format: 'text',
      redact: true,
    });
    expect(consoleSpy).toHaveBeenCalledWith(DEFAULT_TRANSCRIPT_REDACTION_MESSAGE);
  });

  it('requires explicit include-pii opt-in before printing raw transcript content', async () => {
    const getMock = vi.fn().mockResolvedValue({
      ok: true,
      data: 'Alice: budget discussion',
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runTranscriptGetCommand(
      {
        transcripts: { get: getMock },
      } as never,
      'text',
      'rec_123',
      { format: 'text', includePii: true },
    );

    expect(getMock).toHaveBeenCalledWith('rec_123', {
      format: 'text',
      redact: false,
    });
    expect(consoleSpy).toHaveBeenCalledWith('Alice: budget discussion');
  });

  it('keeps machine-readable output safe by default unless include-pii is set', async () => {
    const getMock = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        id: 'trx_1',
        segments: [{ text: 'Alice budget discussion' }],
      },
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runTranscriptGetCommand(
      {
        transcripts: { get: getMock },
      } as never,
      'json',
      'rec_123',
      { format: 'json' },
    );

    expect(getMock).toHaveBeenCalledWith('rec_123', {
      format: 'json',
      redact: true,
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          redacted: true,
          message: DEFAULT_TRANSCRIPT_REDACTION_MESSAGE,
        },
        null,
        2,
      ),
    );
  });
});
