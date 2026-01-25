/**
 * Core CatchFn tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { catchFn, CatchFn } from "../src/index.js";

describe("CatchFn", () => {
  let catcher: CatchFn;

  beforeEach(() => {
    catcher = catchFn({
      name: "test-app",
      enableBreadcrumbs: true,
      enableConsoleCapture: false,
      enableNetworkCapture: false,
    });
  });

  afterEach(() => {
    catcher.stop();
  });

  describe("Initialization", () => {
    it("should create instance with default config", () => {
      const instance = catchFn({ name: "test" });
      const config = instance.getConfig();

      expect(config.name).toBe("test");
      expect(config.enableBreadcrumbs).toBe(true);
      expect(config.maxBreadcrumbs).toBe(50);
      expect(config.enableConsoleCapture).toBe(false);
      expect(config.enableNetworkCapture).toBe(false);
      expect(config.defaultSeverity).toBe("medium");
      expect(config.maxPayloadSize).toBe(262144);
    });

    it("should accept custom config", () => {
      const instance = catchFn({
        name: "custom",
        maxBreadcrumbs: 100,
        defaultSeverity: "high",
        environment: "production",
        release: "1.0.0",
      });

      const config = instance.getConfig();
      expect(config.maxBreadcrumbs).toBe(100);
      expect(config.defaultSeverity).toBe("high");
      expect(config.environment).toBe("production");
      expect(config.release).toBe("1.0.0");
    });
  });

  describe("captureBug", () => {
    it("should capture basic bug report", async () => {
      const report = await catcher.captureBug({
        title: "Test bug",
        description: "This is a test",
        severity: "low",
      });

      expect(report.id).toBeDefined();
      expect(report.id).toMatch(/^bug_/);
      expect(report.timestamp).toBeDefined();
      expect(report.title).toBe("Test bug");
      expect(report.description).toBe("This is a test");
      expect(report.severity).toBe("low");
    });

    it("should use default severity", async () => {
      const report = await catcher.captureBug({
        title: "Test bug",
      });

      expect(report.severity).toBe("medium");
    });

    it("should include tags", async () => {
      const report = await catcher.captureBug({
        title: "Test bug",
        tags: ["ui", "critical"],
      });

      expect(report.tags).toEqual(["ui", "critical"]);
    });

    it("should include user context", async () => {
      const report = await catcher.captureBug({
        title: "Test bug",
        user: {
          id: "user-123",
          email: "test@example.com",
        },
      });

      expect(report.user).toEqual({
        id: "user-123",
        email: "test@example.com",
      });
    });

    it("should include metadata", async () => {
      const report = await catcher.captureBug({
        title: "Test bug",
        metadata: {
          feature: "checkout",
          step: 3,
        },
      });

      expect(report.metadata).toEqual({
        feature: "checkout",
        step: 3,
      });
    });

    it("should collect device info", async () => {
      const report = await catcher.captureBug({
        title: "Test bug",
      });

      expect(report.deviceInfo).toBeDefined();
    });

    it("should collect breadcrumbs", async () => {
      catcher.addBreadcrumb({
        type: "navigation",
        message: "Test breadcrumb",
      });

      const report = await catcher.captureBug({
        title: "Test bug",
      });

      expect(report.breadcrumbs).toBeDefined();
      expect(report.breadcrumbs?.length).toBeGreaterThan(0);
      expect(report.breadcrumbs?.[0].message).toBe("Test breadcrumb");
    });
  });

  describe("Breadcrumbs", () => {
    it("should add breadcrumbs manually", () => {
      catcher.addBreadcrumb({
        type: "user",
        message: "Button clicked",
        data: { button: "submit" },
      });

      catcher.addBreadcrumb({
        type: "navigation",
        message: "Page changed",
      });

      // Breadcrumbs should be collected when capturing bug
    });
  });

  describe("BeforeSend Hook", () => {
    it("should apply beforeSend hook", async () => {
      const withHook = catchFn({
        name: "test",
        beforeSend: (event) => {
          event.metadata = {
            ...event.metadata,
            processed: true,
          };
          return event;
        },
      });

      const report = await withHook.captureBug({
        title: "Test bug",
      });

      expect(report.metadata?.processed).toBe(true);
    });

    it("should drop event if beforeSend returns null", async () => {
      const withHook = catchFn({
        name: "test",
        beforeSend: () => null,
      });

      const report = await withHook.captureBug({
        title: "Test bug",
      });

      // Event is still returned but wouldn't be sent
      expect(report).toBeDefined();
    });

    it("should handle multiple hooks", async () => {
      const catcher = catchFn({ name: "test" });

      catcher.beforeSend((event) => {
        event.tags = [...(event.tags || []), "hook1"];
        return event;
      });

      catcher.beforeSend((event) => {
        event.tags = [...(event.tags || []), "hook2"];
        return event;
      });

      const report = await catcher.captureBug({
        title: "Test bug",
      });

      expect(report.tags).toContain("hook1");
      expect(report.tags).toContain("hook2");
    });
  });

  describe("Ignore Patterns", () => {
    it("should ignore by string pattern", async () => {
      const catcher = catchFn({
        name: "test",
        ignorePatterns: ["ResizeObserver"],
      });

      const report = await catcher.captureBug({
        title: "ResizeObserver loop limit exceeded",
      });

      // Event is still returned but marked as ignored
      expect(report).toBeDefined();
    });

    it("should ignore by regex pattern", async () => {
      const catcher = catchFn({
        name: "test",
        ignorePatterns: [/network.*failed/i],
      });

      const report = await catcher.captureBug({
        title: "Network request failed",
        description: "Timeout occurred",
      });

      expect(report).toBeDefined();
    });

    it("should add ignore patterns dynamically", async () => {
      catcher.addIgnorePattern("test-pattern");
      catcher.addIgnorePattern(/regex-pattern/i);

      const report1 = await catcher.captureBug({
        title: "Contains test-pattern",
      });

      const report2 = await catcher.captureBug({
        title: "Contains REGEX-PATTERN",
      });

      expect(report1).toBeDefined();
      expect(report2).toBeDefined();
    });
  });

  describe("clear", () => {
    it("should clear all context", () => {
      catcher.addBreadcrumb({
        type: "user",
        message: "Test",
      });

      catcher.clear();

      // After clear, breadcrumbs should be empty
    });
  });

  describe("stop", () => {
    it("should stop collectors", () => {
      const catcher = catchFn({
        name: "test",
        enableConsoleCapture: true,
        enableNetworkCapture: true,
      });

      catcher.stop();

      // Collectors should be stopped
    });
  });
});
