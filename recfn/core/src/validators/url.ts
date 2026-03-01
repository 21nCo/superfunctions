import type { Platform } from '../types.js';
import { createError, ErrorCode } from '../errors.js';

interface UrlValidationResult {
  platform: Platform;
  meetingUrl: string;
}

const PLATFORM_PATTERNS: { platform: Platform; pattern: RegExp }[] = [
  {
    platform: 'zoom',
    pattern: /^https?:\/\/([\w-]+\.)?zoom\.us\//i,
  },
  {
    platform: 'meet',
    pattern: /^https?:\/\/meet\.google\.com\//i,
  },
  {
    platform: 'teams',
    pattern: /^https?:\/\/teams\.microsoft\.com\//i,
  },
];

export function detectPlatform(meetingUrl: string): Platform | null {
  for (const { platform, pattern } of PLATFORM_PATTERNS) {
    if (pattern.test(meetingUrl)) {
      return platform;
    }
  }
  return null;
}

export function validateMeetingUrl(
  meetingUrl: string,
  explicitPlatform?: Platform,
): UrlValidationResult {
  let url: URL;
  try {
    url = new URL(meetingUrl);
  } catch {
    throw createError(
      ErrorCode.BOT_CREATE_FAILED,
      'Invalid meeting URL.',
      { meetingUrl },
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw createError(
      ErrorCode.BOT_CREATE_FAILED,
      'Meeting URL must use http or https protocol.',
      { meetingUrl },
    );
  }

  const detected = detectPlatform(meetingUrl);

  if (explicitPlatform) {
    if (detected && detected !== explicitPlatform) {
      throw createError(
        ErrorCode.BOT_CREATE_FAILED,
        `URL appears to be for ${detected}, but platform was specified as ${explicitPlatform}.`,
        { meetingUrl, detected, specified: explicitPlatform },
      );
    }
    return { platform: explicitPlatform, meetingUrl };
  }

  if (!detected) {
    throw createError(
      ErrorCode.BOT_CREATE_FAILED,
      'Unrecognized meeting URL. Supported platforms: zoom, meet, teams.',
      { meetingUrl },
    );
  }

  return { platform: detected, meetingUrl };
}
