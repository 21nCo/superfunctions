import { createProbefnError, type BrowserEngine } from '@probefn/contracts';

export type ViewportTag = 'desktop' | 'tablet' | 'mobile';
export type ColorScheme = 'light' | 'dark';

export interface BaselineKeyParts {
  routeIdentity: string;
  viewportTag: ViewportTag;
  browser: BrowserEngine;
  colorScheme: ColorScheme;
  width: number;
  height: number;
  timezoneTag: string;
}

const BASELINE_KEY_PATTERN =
  /^(?<routeIdentity>[a-z0-9._-]+)\.(?<viewportTag>desktop|tablet|mobile)\.(?<browser>chromium|firefox|webkit)\.(?<colorScheme>light|dark)\.(?<width>\d+)x(?<height>\d+)\.(?<timezoneTag>[a-z0-9._-]+)$/i;

export function buildBaselineKey(parts: BaselineKeyParts): string {
  return [
    sanitizeSegment(parts.routeIdentity),
    parts.viewportTag,
    parts.browser,
    parts.colorScheme,
    `${parts.width}x${parts.height}`,
    sanitizeSegment(parts.timezoneTag),
  ].join('.');
}

export function parseBaselineKey(key: string): BaselineKeyParts {
  const match = BASELINE_KEY_PATTERN.exec(key.trim());
  const groups = match?.groups;
  if (!groups) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: `Invalid baseline key ${key}.`,
      retryable: false,
      details: {
        baselineKey: key,
      },
    });
  }

  return {
    routeIdentity: (groups.routeIdentity ?? '').toLowerCase(),
    viewportTag: ((groups.viewportTag ?? '').toLowerCase() as ViewportTag),
    browser: ((groups.browser ?? '').toLowerCase() as BrowserEngine),
    colorScheme: ((groups.colorScheme ?? '').toLowerCase() as ColorScheme),
    width: Number.parseInt(groups.width ?? '0', 10),
    height: Number.parseInt(groups.height ?? '0', 10),
    timezoneTag: (groups.timezoneTag ?? '').toLowerCase(),
  };
}

export function inferViewportTag(
  viewport: {
    width: number;
    height: number;
  },
): ViewportTag {
  if (viewport.width <= 430) {
    return 'mobile';
  }

  if (viewport.width <= 1024) {
    return 'tablet';
  }

  return 'desktop';
}

function sanitizeSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (sanitized.length === 0) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: 'Baseline key segments must contain at least one safe character.',
      retryable: false,
    });
  }

  return sanitized;
}
