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

  it("ignores plain error and unhandledrejection events that the page dispatches itself", () => {
    collector.start();
    window.dispatchEvent(new Event("error"));
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "forged" }));
    expect(collector.collect()).toEqual([]);
  });

  it("redacts script URLs in the stack as in filename, keeping line and column", () => {
    collector.start();
    const error = new Error("from script");
    // Userinfo is built at runtime, so no credential-shaped URL is committed.
    const withUserinfo = new URL("https://cdn.example.com/app.js");
    withUserinfo.username = "test-user";
    withUserinfo.password = "stack-secret";
    error.stack = [
      "Error: from script",
      "    at load (https://cdn.example.com/app.js?token=stack-secret&v=2:12:7)",
      "    at https://cdn.example.com/app.js?token=stack-secret:3:1",
      "    at run (https://cdn.example.com/app(1).js?token=stack-secret:8:9)",
      // A sensitive value that itself ends in colon-separated digits.
      "    at deep (https://cdn.example.com/app.js?token=stack-secret:4321:8:9)",
      `load@${withUserinfo.href}:4:5`,
    ].join("\n");
    window.dispatchEvent(new ErrorEvent("error", { error, message: "Uncaught Error: from script", filename: "https://cdn.example.com/app.js?token=stack-secret" }));
    reject(error);
    for (const event of collector.collect()) {
      expect(JSON.stringify(event)).not.toContain("stack-secret");
      expect(event.stack).toMatch(/at load \(https:\/\/cdn\.example\.com\/app\.js\?token=[^&]+&v=2:12:7\)/);
      expect(event.stack).toContain(":3:1\n");
      expect(event.stack).toMatch(/at run \(https:\/\/cdn\.example\.com\/app\(1\)\.js\?token=[^:]+:8:9\)/);
      expect(event.stack).not.toContain("test-user");
      expect(event.stack).not.toContain("4321");
      expect(event.stack).toMatch(/at deep \(https:\/\/cdn\.example\.com\/app\.js\?token=[^:]+:8:9\)/);
      expect(event.stack).toMatch(/load@https:\/\/cdn\.example\.com\/app\.js:4:5$/);
    }
    expect(collector.size()).toBe(2);
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

  it("subscribes once when installing reenters start() or stop() of the same collector", () => {
    const original = window.addEventListener;
    const originalRemove = window.removeEventListener;
    const ours = (calls: unknown[][]) => calls.filter(([type]) => type === "error" || type === "unhandledrejection").map(([type, listener]) => [type, listener]);
    // Page code in a replaced addEventListener that restarts the collector while it installs.
    const add = vi.spyOn(window, "addEventListener").mockImplementationOnce(function (this: Window, ...args: Parameters<Window["addEventListener"]>) {
      collector.start();
      return original.apply(this, args);
    });
    const remove = vi.spyOn(window, "removeEventListener");
    collector.start();
    reject("once");
    collector.stop();
    reject("after stop");
    expect(collector.collect().map((event) => event.message)).toEqual(["once"]);
    expect(ours(add.mock.calls)).toHaveLength(2);
    expect(ours(remove.mock.calls)).toEqual(ours(add.mock.calls));
    // Stopped while installing: nothing stays installed, and a later start() records once.
    add.mockImplementationOnce(function (this: Window, ...args: Parameters<Window["addEventListener"]>) {
      collector.stop();
      return original.apply(this, args);
    });
    collector.start();
    reject("cancelled");
    expect(ours(remove.mock.calls)).toEqual(ours(add.mock.calls));
    collector.start();
    reject("restarted");
    collector.stop();
    expect(collector.collect().map((event) => event.message)).toEqual(["once", "restarted"]);
    expect(ours(remove.mock.calls)).toEqual(ours(add.mock.calls));
    // Restarted by page code in a replaced removeEventListener while stop() tears down: the new session is kept and its own stop() removes it.
    remove.mockImplementationOnce(function (this: Window, ...args: Parameters<Window["removeEventListener"]>) {
      collector.start();
      return originalRemove.apply(this, args);
    });
    collector.start();
    collector.stop();
    reject("restarted in teardown");
    collector.stop();
    reject("after the last stop");
    expect(collector.collect().map((event) => event.message).slice(2)).toEqual(["restarted in teardown"]);
    // Each listener added is removed by its exact type and listener, whatever the order.
    expect(ours(remove.mock.calls)).toHaveLength(ours(add.mock.calls).length);
    expect(ours(remove.mock.calls)).toEqual(expect.arrayContaining(ours(add.mock.calls)));
  });

  for (const failing of ["error", "unhandledrejection"] as const) {
    it(`removes a ${failing} listener whose addEventListener registered it and then threw, and a restart records once`, () => {
      const original = window.addEventListener;
      const ours = (calls: unknown[][]) => calls.filter(([type]) => type === "error" || type === "unhandledrejection").map(([type, listener]) => [type, listener]);
      let throwing = true;
      const add = vi.spyOn(window, "addEventListener").mockImplementation(function (this: Window, ...args: Parameters<Window["addEventListener"]>) {
        original.apply(this, args);
        if (throwing && args[0] === failing) throw new Error("registered, then threw");
      });
      const remove = vi.spyOn(window, "removeEventListener");
      const other = new ErrorCollector(10);
      try {
        collector.start();
        other.start(); // Joins the session that failed to install.
        reject("not recorded");
        expect(collector.collect()).toEqual([]);
        expect(other.collect()).toEqual([]);
        // Every listener added, the one whose registration threw included, is removed by its exact type and listener.
        expect(ours(add.mock.calls).map(([type]) => type)).toEqual(failing === "error" ? ["error"] : ["error", "unhandledrejection"]);
        expect(ours(remove.mock.calls)).toEqual(ours(add.mock.calls));
        collector.stop();
        other.stop();
        throwing = false;
        collector.start();
        other.start();
        reject("restarted");
        collector.stop();
        other.stop();
        reject("after the last stop");
        expect(collector.collect().map((event) => event.message)).toEqual(["restarted"]);
        expect(other.collect().map((event) => event.message)).toEqual(["restarted"]);
        expect(ours(remove.mock.calls)).toEqual(ours(add.mock.calls));
        expectValidEvents(other.collect());
      } finally {
        other.stop();
      }
    });
  }

  it("drops an error whose clock gives no valid v1 timestamp", async () => {
    const realNow = Date.now;
    let clock: () => unknown = realNow;
    Date.now = () => clock() as number;
    vi.resetModules();
    let fresh: typeof import("../src/collectors/errors.js");
    try {
      fresh = await import("../src/collectors/errors.js"); // Captures the clock above.
    } finally {
      Date.now = realNow;
    }
    const timed = new fresh.ErrorCollector(10);
    timed.start();
    try {
      const invalid: Array<() => unknown> = [() => Number.NaN, () => 1.5, () => -1, () => "1700000000000", () => Number.POSITIVE_INFINITY, () => 2 ** 53];
      for (const each of [...invalid, () => { throw new Error("clock"); }]) {
        clock = each;
        reject("dropped");
        throwUncaught(new Error("dropped"));
      }
      expect(timed.collect()).toEqual([]);
      clock = () => 1_700_000_000_000;
      reject("kept");
      throwUncaught(new Error("kept"));
      expect(timed.collect().map(({ source, timestamp }) => [source, timestamp])).toEqual([
        ["unhandledrejection", 1_700_000_000_000],
        ["error", 1_700_000_000_000],
      ]);
      expectValidEvents(timed.collect());
    } finally {
      timed.stop();
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

  it("delivers an event only to collectors subscribed before reading it ran page code and still subscribed after", () => {
    const restarted = new ErrorCollector(10);
    const stopped = new ErrorCollector(10);
    collector.start();
    restarted.start();
    stopped.start();
    const reason = new Error("reentrant");
    Object.defineProperty(reason, "name", {
      get() {
        restarted.stop();
        restarted.start(); // A new subscription, after this rejection happened.
        stopped.stop();
        return "Error";
      },
    });
    reject(reason);
    reject("later");
    restarted.stop();
    stopped.stop();
    expect(collector.collect().map((event) => event.message)).toEqual(["reentrant", "later"]);
    expect(restarted.collect().map((event) => event.message)).toEqual(["later"]);
    expect(stopped.collect()).toEqual([]);
    expectValidEvents(restarted.collect());
  });

  it("bounds a huge message and stack to one 10 KB entry", () => {
    collector.start();
    reject(new Error("x".repeat(50_000)));
    const [event] = collector.collect();
    expect(new TextEncoder().encode(JSON.stringify([event!.name, event!.message, event!.stack])).byteLength).toBeLessThanOrEqual(10 * 1024 + 64);
    expect(event!.message).toContain("[Truncated]");
  });
});
