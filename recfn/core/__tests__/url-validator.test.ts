import { describe, it, expect } from 'vitest';
import { detectPlatform, validateMeetingUrl } from '../src/validators/url.js';
import { RecFnError } from '../src/errors.js';

describe('detectPlatform', () => {
  it('detects Zoom URLs', () => {
    expect(detectPlatform('https://zoom.us/j/1234567890?pwd=abc123')).toBe('zoom');
    expect(detectPlatform('https://us02web.zoom.us/j/123')).toBe('zoom');
  });

  it('detects Google Meet URLs', () => {
    expect(detectPlatform('https://meet.google.com/abc-defg-hij')).toBe('meet');
  });

  it('detects Microsoft Teams URLs', () => {
    expect(detectPlatform('https://teams.microsoft.com/l/meetup-join/123')).toBe('teams');
  });

  it('returns null for unrecognized URLs', () => {
    expect(detectPlatform('https://example.com/not-a-meeting')).toBeNull();
    expect(detectPlatform('https://webex.com/meet/123')).toBeNull();
  });
});

describe('validateMeetingUrl', () => {
  it('validates and detects platform from Zoom URL (TV-BOT-001)', () => {
    const result = validateMeetingUrl('https://zoom.us/j/1234567890?pwd=abc123');
    expect(result.platform).toBe('zoom');
    expect(result.meetingUrl).toBe('https://zoom.us/j/1234567890?pwd=abc123');
  });

  it('validates Google Meet URL', () => {
    const result = validateMeetingUrl('https://meet.google.com/abc-defg-hij');
    expect(result.platform).toBe('meet');
  });

  it('validates Teams URL', () => {
    const result = validateMeetingUrl('https://teams.microsoft.com/l/meetup-join/123');
    expect(result.platform).toBe('teams');
  });

  it('accepts explicit platform matching URL', () => {
    const result = validateMeetingUrl('https://zoom.us/j/123', 'zoom');
    expect(result.platform).toBe('zoom');
  });

  it('accepts explicit platform for non-matching URL', () => {
    const result = validateMeetingUrl('https://custom.zoom-proxy.com/j/123', 'zoom');
    expect(result.platform).toBe('zoom');
  });

  it('throws BOT_CREATE_FAILED for unrecognized URL (TV-BOT-002)', () => {
    expect(() => validateMeetingUrl('https://example.com/not-a-meeting')).toThrow(RecFnError);
    try {
      validateMeetingUrl('https://example.com/not-a-meeting');
    } catch (e) {
      const err = e as RecFnError;
      expect(err.code).toBe('BOT_CREATE_FAILED');
      expect(err.message).toContain('Unrecognized meeting URL');
      expect(err.message).toContain('zoom, meet, teams');
    }
  });

  it('throws for invalid URL format', () => {
    expect(() => validateMeetingUrl('not-a-url')).toThrow(RecFnError);
    try {
      validateMeetingUrl('not-a-url');
    } catch (e) {
      expect((e as RecFnError).code).toBe('BOT_CREATE_FAILED');
    }
  });

  it('throws when explicit platform mismatches detected platform', () => {
    expect(() =>
      validateMeetingUrl('https://zoom.us/j/123', 'meet'),
    ).toThrow(RecFnError);
    try {
      validateMeetingUrl('https://zoom.us/j/123', 'meet');
    } catch (e) {
      const err = e as RecFnError;
      expect(err.code).toBe('BOT_CREATE_FAILED');
      expect(err.message).toContain('zoom');
      expect(err.message).toContain('meet');
    }
  });

  it('throws for non-http protocol', () => {
    expect(() => validateMeetingUrl('ftp://zoom.us/j/123')).toThrow(RecFnError);
  });
});
