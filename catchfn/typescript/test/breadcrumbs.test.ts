import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbCollector } from "../src/collectors/breadcrumbs.js";
import { expectValidEvents } from "./schema-helper.js";

let collector: BreadcrumbCollector;

beforeEach(() => {
  collector = new BreadcrumbCollector(10);
});

afterEach(() => {
  expectValidEvents(collector.collect());
});

describe("BreadcrumbCollector", () => {
  it("records a breadcrumb as a v1 event with a timestamp", () => {
    collector.add({ type: "navigation", message: "Test breadcrumb" });
    const [event] = collector.collect();
    expect(event).toMatchObject({ schemaVersion: 1, kind: "breadcrumb", type: "navigation", message: "Test breadcrumb" });
    expect(Number.isInteger(event!.timestamp)).toBe(true);
    expect(event).not.toHaveProperty("data");
  });

  it("keeps the newest maxSize breadcrumbs", () => {
    for (let index = 0; index < 15; index += 1) collector.add({ type: "custom", message: `Breadcrumb ${index}` });
    const events = collector.collect();
    expect(events).toHaveLength(10);
    expect(events[0]!.message).toBe("Breadcrumb 5");
    expect(events[9]!.message).toBe("Breadcrumb 14");
  });

  it("adds navigation, console and user breadcrumbs", () => {
    collector.addNavigation("/home", "/dashboard");
    collector.addConsole("error", "Something went wrong");
    collector.addUser("click", "submit-button", { form: "checkout" });
    const [navigation, consoleEvent, user] = collector.collect();
    expect(navigation).toMatchObject({ type: "navigation", message: "/home → /dashboard", data: { from: "/home", to: "/dashboard" }, category: "navigation" });
    expect(consoleEvent).toMatchObject({ type: "console", message: "Something went wrong", level: "error", category: "console" });
    expect(user).toMatchObject({ type: "user", message: "click on submit-button", data: { action: "click", target: "submit-button", form: "checkout" } });
  });

  it("adds network breadcrumbs with a redacted URL and error level for 4xx/5xx", () => {
    collector.addNetwork("GET", "/api/users?token=abc&page=2", 200);
    collector.addNetwork("POST", "/api/data", 500);
    collector.addNetwork("GET", "/api/pending");
    const [ok, failed, pending] = collector.collect();
    expect(ok!.data).toMatchObject({ method: "GET", status: 200 });
    expect(JSON.stringify(ok)).not.toContain("abc");
    expect(String(ok!.data?.url)).toContain("page=2");
    expect(ok!.level).toBe("info");
    expect(failed!.level).toBe("error");
    expect(pending!.data).toEqual({ method: "GET", url: "/api/pending" });
  });

  it("serializes data under the closed set", () => {
    const cyclic: Record<string, unknown> = { id: 1 };
    cyclic.self = cyclic;
    collector.add({ type: "custom", data: { cyclic, when: new Date(0), big: 2n } });
    expect(collector.collect()[0]!.data).toEqual({ cyclic: { id: 1, self: "[Circular]" }, when: String(new Date(0)), big: "2" });
  });

  it("rejects a type or level outside the v1 format", () => {
    expect(() => collector.add({ type: "bogus" as never })).toThrow(TypeError);
    expect(() => collector.add({ type: "custom", level: "fatal" as never })).toThrow(TypeError);
    expect(collector.size()).toBe(0);
  });

  it("filters by time window, returns copies, clears and reports size", () => {
    const now = vi.spyOn(Date, "now");
    for (const time of [10, 20, 30]) {
      now.mockReturnValue(time);
      collector.add({ type: "custom", message: `t${time}` });
    }
    now.mockRestore();
    expect(collector.collect({ since: 20, until: 30 }).map((event) => event.message)).toEqual(["t20", "t30"]);
    expect(collector.collect()).not.toBe(collector.collect());
    expect(collector.size()).toBe(3);
    collector.clear();
    expect(collector.size()).toBe(0);
    expect(() => new BreadcrumbCollector(1.5)).toThrow(RangeError);
  });
});
