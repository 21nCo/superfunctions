import { describe, it, expect } from 'vitest';
import { validateBotConfig, getAsrProviders } from '../src/validators/bot-config.js';
import { RecFnError } from '../src/errors.js';

describe('validateBotConfig', () => {
  it('applies all defaults when no config provided', () => {
    const result = validateBotConfig();
    expect(result).toEqual({
      displayName: 'RecFn Bot',
      joinTimeout: 30_000,
      autoLeaveOnEmpty: true,
      autoLeaveEmptyTimeout: 30_000,
      consentMessage: 'This meeting is being recorded',
      enableRealTimeTranscript: false,
      asrProvider: 'whisper',
      recordingFormat: 'mp4',
      language: 'en-US',
    });
  });

  it('applies defaults for empty config', () => {
    const result = validateBotConfig({});
    expect(result.displayName).toBe('RecFn Bot');
    expect(result.asrProvider).toBe('whisper');
    expect(result.language).toBe('en-US');
  });

  it('merges provided config with defaults (TV-BOT-012)', () => {
    const result = validateBotConfig({
      displayName: 'My Recorder',
      joinTimeout: 15000,
      autoLeaveOnEmpty: false,
      consentMessage: 'This session is being recorded for compliance.',
      enableRealTimeTranscript: true,
      asrProvider: 'deepgram',
      recordingFormat: 'audio_only',
      language: 'es-ES',
    });
    expect(result.displayName).toBe('My Recorder');
    expect(result.joinTimeout).toBe(15000);
    expect(result.autoLeaveOnEmpty).toBe(false);
    expect(result.autoLeaveEmptyTimeout).toBe(30_000);
    expect(result.consentMessage).toBe('This session is being recorded for compliance.');
    expect(result.enableRealTimeTranscript).toBe(true);
    expect(result.asrProvider).toBe('deepgram');
    expect(result.recordingFormat).toBe('audio_only');
    expect(result.language).toBe('es-ES');
  });

  it('throws BAD_REQUEST for unknown ASR provider (TV-BOT-012 negative)', () => {
    expect(() =>
      validateBotConfig({ asrProvider: 'nonexistent' }),
    ).toThrow(RecFnError);
    try {
      validateBotConfig({ asrProvider: 'nonexistent' });
    } catch (e) {
      const err = e as RecFnError;
      expect(err.code).toBe('BAD_REQUEST');
      expect(err.message).toContain('Unknown ASR provider: nonexistent');
    }
  });

  it('accepts all known ASR providers', () => {
    for (const provider of ['whisper', 'deepgram', 'assemblyai', 'google-stt']) {
      expect(() => validateBotConfig({ asrProvider: provider })).not.toThrow();
    }
  });

  it('throws BAD_REQUEST for joinTimeout > 60000', () => {
    expect(() =>
      validateBotConfig({ joinTimeout: 90_000 }),
    ).toThrow(RecFnError);
    try {
      validateBotConfig({ joinTimeout: 90_000 });
    } catch (e) {
      expect((e as RecFnError).code).toBe('BAD_REQUEST');
    }
  });

  it('throws BAD_REQUEST for joinTimeout < 1000', () => {
    expect(() =>
      validateBotConfig({ joinTimeout: 500 }),
    ).toThrow(RecFnError);
  });

  it('throws BAD_REQUEST for negative autoLeaveEmptyTimeout', () => {
    expect(() =>
      validateBotConfig({ autoLeaveEmptyTimeout: -1 }),
    ).toThrow(RecFnError);
  });

  it('throws BAD_REQUEST for invalid recordingFormat', () => {
    expect(() =>
      validateBotConfig({ recordingFormat: 'avi' as 'mp4' }),
    ).toThrow(RecFnError);
  });
});

describe('getAsrProviders', () => {
  it('returns known providers list', () => {
    const providers = getAsrProviders();
    expect(providers).toContain('whisper');
    expect(providers).toContain('deepgram');
    expect(providers).toContain('assemblyai');
    expect(providers).toContain('google-stt');
  });
});
