/**
 * DeviceCollector tests
 */

import { describe, it, expect } from "vitest";
import { DeviceCollector } from "../../src/collectors/device.js";

describe("DeviceCollector", () => {
  describe("collect", () => {
    it("should collect device info", () => {
      const info = DeviceCollector.collect();

      expect(info).toBeDefined();
      expect(typeof info).toBe("object");
    });

    it("should include Node.js info in Node environment", () => {
      const info = DeviceCollector.collect();

      // In Node.js test environment
      expect(info.platform).toBeDefined();
      expect(info.nodeVersion).toBeDefined();
      expect(info.memoryUsage).toBeDefined();

      if (info.memoryUsage) {
        expect(info.memoryUsage.rss).toBeGreaterThan(0);
        expect(info.memoryUsage.heapTotal).toBeGreaterThan(0);
        expect(info.memoryUsage.heapUsed).toBeGreaterThan(0);
      }
    });

    it("should include timezone if available", () => {
      const info = DeviceCollector.collect();

      // Timezone should be available in most environments
      if (typeof Intl !== "undefined") {
        expect(info.timezone).toBeDefined();
      }
    });
  });
});
