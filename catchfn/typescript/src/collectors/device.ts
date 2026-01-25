/**
 * Device and environment information collector
 */

import type { DeviceInfo } from "../core/types.js";

export class DeviceCollector {
  /**
   * Collect device and environment information
   */
  static collect(): DeviceInfo {
    const info: DeviceInfo = {};

    // Browser environment
    if (typeof navigator !== "undefined") {
      info.userAgent = navigator.userAgent;
      info.platform = navigator.platform;
      info.language = navigator.language;

      if (typeof globalThis !== "undefined" && "screen" in globalThis) {
        const screen = (globalThis as any).screen;
        info.screenResolution = `${screen.width}x${screen.height}`;
      }

      if (typeof globalThis !== "undefined" && "window" in globalThis) {
        const window = (globalThis as any).window;
        info.viewportSize = `${window.innerWidth}x${window.innerHeight}`;
      }
    }

    // Node.js environment
    if (typeof process !== "undefined") {
      info.platform = process.platform;
      info.nodeVersion = process.version;

      if (process.memoryUsage) {
        const mem = process.memoryUsage();
        info.memoryUsage = {
          rss: mem.rss,
          heapTotal: mem.heapTotal,
          heapUsed: mem.heapUsed,
          external: mem.external,
        };
      }
    }

    // Timezone
    try {
      info.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      // Ignore if Intl is not available
    }

    return info;
  }
}
