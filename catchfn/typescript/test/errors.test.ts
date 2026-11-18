// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCollector } from "../src/collectors/errors.js";
import { expectValidEvents } from "./schema-helper.js";

let collector: ErrorCollector;

/** An exception thrown by a page event listener, which the DOM reports to the window. */
function throwUncaught(value: unknown): void {
  const button = document.createElement("button");
  button.addEventListener("click", () => {
    throw value;
  });
  button.click();
}

function reject(reason: unknown): PromiseRejectionEvent {
  const promise = Promise.reject(reason);
  promise.catch(() => undefined); // Only the dispatched event reports it; keep Node quiet.
  const event = new PromiseRejectionEvent("unhandledrejection", { promise, reason, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  // jsdom also prints a reported exception through the console.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  collector = new ErrorCollector(10);
});

afterEach(() => {
  const events = collector.collect();
  collector.stop();
  vi.restoreAllMocks();
  expectValidEvents(events);
});

describe("ErrorCollector", () => {
  it("records an uncaught error with its name, message, stack and script position", () => {
    collector.start();
    throwUncaught(new TypeError("boom"));
    const [event, ...rest] = collector.collect();
    expect(rest).toEqual([]);
    expect(event).toMatchObject({ schemaVersion: 1, kind: "error", source: "error", name: "TypeError" });
    expect(event!.message).toContain("boom");
    expect(event!.stack).toContain("boom");
    expect(event).not.toHaveProperty("value");
    expect(Object.isFrozen(event)).toBe(true);
  });

  it("records the ErrorEvent fields with the script URL redacted", () => {
    collector.start();
    const error = new Error("from script");
    window.dispatchEvent(
      new ErrorEvent("error", { error, message: "Uncaught Error: from script", filename: "https://cdn.example.com/app.js?token=script-secret", lineno: 12, colno: 7 })
    );
    const [event] = collector.collect();
    expect(event).toMatchObject({ source: "error", name: "Error", message: "Uncaught Error: from script", lineno: 12, colno: 7 });
    expect(event!.filename).toMatch(/^https:\/\/cdn\.example\.com\/app\.js\?token=/);
    expect(JSON.stringify(event)).not.toContain("script-secret");
  });

  it("records a thrown non-Error value and a cross-origin error without one", () => {
    collector.start();
    throwUncaught({ code: 42 });
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    const [thrown, crossOrigin] = collector.collect();
    expect(thrown).toMatchObject({ source: "error", value: { code: 42 } });
    expect(thrown).not.toHaveProperty("name");
    expect(crossOrigin).toMatchObject({ source: "error", message: "Script error." });
    expect(crossOrigin).not.toHaveProperty("value");
  });

  it("ignores a plain error event that is not an uncaught exception", () => {
    collector.start();
    window.dispatchEvent(new Event("error"));
    expect(collector.collect()).toEqual([]);
  });

  it("records an unhandled rejection with an Error reason", () => {
    collector.start();
    reject(new RangeError("rejected"));
    const [event] = collector.collect();
    expect(event).toMatchObject({ kind: "error", source: "unhandledrejection", name: "RangeError", message: "rejected" });
    expect(event!.stack).toContain("rejected");
    expect(event).not.toHaveProperty("value");
  });

  it.each([
    ["a string", "plain reason", "plain reason", "plain reason"],
    ["an object", { status: 503 }, { status: 503 }, '{"status":503}'],
    ["undefined", undefined, "undefined", "undefined"],
  ])("records an unhandled rejection with %s as the reason", (_label, reason, value, message) => {
    collector.start();
    reject(reason);
    const [event] = collector.collect();
    expect(event).toMatchObject({ source: "unhandledrejection", value, message });
    expect(event).not.toHaveProperty("name");
    expect(event).not.toHaveProperty("stack");
  });

  it("never cancels the event, so the page's handlers and the default report still run", () => {
    const page = vi.fn();
    window.addEventListener("unhandledrejection", page);
    collector.start();
    try {
      const event = reject("still unhandled");
      expect(event.defaultPrevented).toBe(false);
      expect(page).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("unhandledrejection", page);
    }
  });

  it("keeps the newest maxSize events and supports maxSize 0", () => {
    const small = new ErrorCollector(2);
    const none = new ErrorCollector(0);
    small.start();
    none.start();
    for (const reason of ["one", "two", "three"]) reject(reason);
    small.stop();
    none.stop();
    expect(small.collect().map((event) => event.message)).toEqual(["two", "three"]);
    expect(none.size()).toBe(0);
  });

  it("removes its listeners on stop() and records nothing afterwards", () => {
    // The page's own handler: after stop() the error still reaches it, and only it.
    const page = vi.fn();
    window.addEventListener("error", page);
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      collector.start();
      collector.start(); // A second start() installs nothing more.
      reject("while running");
      collector.stop();
      reject("after stop");
      throwUncaught(new Error("after stop"));
      expect(collector.collect().map((event) => event.message)).toEqual(["while running"]);
      expect(page).toHaveBeenCalledTimes(1);
      // Whatever route installed the listeners, each one added is removed again.
      const ours = (calls: unknown[][]) => calls.filter(([type]) => type === "error" || type === "unhandledrejection").map(([type, listener]) => [type, listener]);
      expect(ours(add.mock.calls)).toHaveLength(2);
      expect(ours(remove.mock.calls)).toEqual(ours(add.mock.calls));
    } finally {
      vi.restoreAllMocks();
      window.removeEventListener("error", page);
    }
  });

  it("lets overlapping collectors each see only what happened while they ran", () => {
    const other = new ErrorCollector(10);
    collector.start();
    reject("first");
    other.start();
    reject("both");
    collector.stop();
    reject("second");
    other.stop();
    expect(collector.collect().map((event) => event.message)).toEqual(["first", "both"]);
    expect(other.collect().map((event) => event.message)).toEqual(["both", "second"]);
    expectValidEvents(other.collect());
  });

  it("bounds a huge message and stack to one 10 KB entry", () => {
    collector.start();
    reject(new Error("x".repeat(50_000)));
    const [event] = collector.collect();
    expect(new TextEncoder().encode(JSON.stringify([event!.name, event!.message, event!.stack])).byteLength).toBeLessThanOrEqual(10 * 1024 + 64);
    expect(event!.message).toContain("[Truncated]");
  });
});
