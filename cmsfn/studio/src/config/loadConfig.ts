/**
 * Load CmsFn Studio config (deployment-defined).
 * In browser: typically from window.__CMSFN_CONFIG__ or fetched from an endpoint.
 */

import type { CmsfnStudioConfig } from "cmsfn";

declare global {
  interface Window {
    __CMSFN_CONFIG__?: CmsfnStudioConfig;
  }
}

/**
 * Load config from window.__CMSFN_CONFIG__ if in browser and present.
 * Otherwise returns null (caller may fetch or use default).
 */
export function loadConfig(): CmsfnStudioConfig | null {
  if (typeof window !== "undefined" && window.__CMSFN_CONFIG__) {
    return window.__CMSFN_CONFIG__;
  }
  return null;
}

/**
 * Get initial dataset (first in config) for deterministic default.
 */
export function getInitialDataset(config: CmsfnStudioConfig): string {
  const first = config.datasets[0];
  return first?.name ?? "";
}
