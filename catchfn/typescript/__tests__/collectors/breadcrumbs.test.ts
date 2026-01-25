/**
 * BreadcrumbCollector tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { BreadcrumbCollector } from "../../src/collectors/breadcrumbs.js";

describe("BreadcrumbCollector", () => {
  let collector: BreadcrumbCollector;

  beforeEach(() => {
    collector = new BreadcrumbCollector(10);
  });

  describe("add", () => {
    it("should add breadcrumb with timestamp", () => {
      collector.add({
        type: "navigation",
        message: "Test breadcrumb",
      });

      const breadcrumbs = collector.collect();
      expect(breadcrumbs).toHaveLength(1);
      expect(breadcrumbs[0].type).toBe("navigation");
      expect(breadcrumbs[0].message).toBe("Test breadcrumb");
      expect(breadcrumbs[0].timestamp).toBeDefined();
    });

    it("should maintain circular buffer", () => {
      // Add 15 breadcrumbs to a collector with max 10
      for (let i = 0; i < 15; i++) {
        collector.add({
          type: "custom",
          message: `Breadcrumb ${i}`,
        });
      }

      const breadcrumbs = collector.collect();
      expect(breadcrumbs).toHaveLength(10);
      // Should keep the last 10
      expect(breadcrumbs[0].message).toBe("Breadcrumb 5");
      expect(breadcrumbs[9].message).toBe("Breadcrumb 14");
    });
  });

  describe("addNavigation", () => {
    it("should add navigation breadcrumb", () => {
      collector.addNavigation("/home", "/dashboard");

      const breadcrumbs = collector.collect();
      expect(breadcrumbs).toHaveLength(1);
      expect(breadcrumbs[0].type).toBe("navigation");
      expect(breadcrumbs[0].message).toBe("/home → /dashboard");
      expect(breadcrumbs[0].data).toEqual({ from: "/home", to: "/dashboard" });
      expect(breadcrumbs[0].category).toBe("navigation");
    });
  });

  describe("addConsole", () => {
    it("should add console breadcrumb", () => {
      collector.addConsole("error", "Something went wrong");

      const breadcrumbs = collector.collect();
      expect(breadcrumbs).toHaveLength(1);
      expect(breadcrumbs[0].type).toBe("console");
      expect(breadcrumbs[0].message).toBe("Something went wrong");
      expect(breadcrumbs[0].level).toBe("error");
      expect(breadcrumbs[0].category).toBe("console");
    });
  });

  describe("addNetwork", () => {
    it("should add network breadcrumb with status", () => {
      collector.addNetwork("GET", "/api/users", 200);

      const breadcrumbs = collector.collect();
      expect(breadcrumbs).toHaveLength(1);
      expect(breadcrumbs[0].type).toBe("network");
      expect(breadcrumbs[0].message).toContain("GET /api/users");
      expect(breadcrumbs[0].data).toEqual({
        method: "GET",
        url: "/api/users",
        status: 200,
      });
      expect(breadcrumbs[0].level).toBe("info");
    });

    it("should mark error status as error level", () => {
      collector.addNetwork("POST", "/api/data", 500);

      const breadcrumbs = collector.collect();
      expect(breadcrumbs[0].level).toBe("error");
    });
  });

  describe("addUser", () => {
    it("should add user interaction breadcrumb", () => {
      collector.addUser("click", "submit-button", { form: "checkout" });

      const breadcrumbs = collector.collect();
      expect(breadcrumbs).toHaveLength(1);
      expect(breadcrumbs[0].type).toBe("user");
      expect(breadcrumbs[0].message).toBe("click on submit-button");
      expect(breadcrumbs[0].data).toEqual({
        action: "click",
        target: "submit-button",
        form: "checkout",
      });
    });
  });

  describe("collect", () => {
    it("should return copy of breadcrumbs", () => {
      collector.add({ type: "custom", message: "Test" });

      const breadcrumbs1 = collector.collect();
      const breadcrumbs2 = collector.collect();

      expect(breadcrumbs1).not.toBe(breadcrumbs2);
      expect(breadcrumbs1).toEqual(breadcrumbs2);
    });
  });

  describe("clear", () => {
    it("should clear all breadcrumbs", () => {
      collector.add({ type: "custom", message: "Test 1" });
      collector.add({ type: "custom", message: "Test 2" });

      expect(collector.size()).toBe(2);

      collector.clear();

      expect(collector.size()).toBe(0);
      expect(collector.collect()).toEqual([]);
    });
  });

  describe("size", () => {
    it("should return current breadcrumb count", () => {
      expect(collector.size()).toBe(0);

      collector.add({ type: "custom", message: "Test 1" });
      expect(collector.size()).toBe(1);

      collector.add({ type: "custom", message: "Test 2" });
      expect(collector.size()).toBe(2);
    });
  });
});
