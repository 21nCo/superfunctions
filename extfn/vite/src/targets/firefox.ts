import type { BrowserTarget } from '@superfunctions/extfn';

export const FIREFOX_TARGET: BrowserTarget = 'firefox-mv3';

export function applyFirefoxTargetManifest(
  manifest: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...manifest,
    browser_specific_settings: {
      gecko: {
        id: 'extfn@example.local',
      },
      ...(isRecord(manifest.browser_specific_settings)
        ? manifest.browser_specific_settings
        : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
