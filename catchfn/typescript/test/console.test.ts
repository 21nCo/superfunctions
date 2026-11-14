import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleCollector } from "../src/collectors/console.js";
import { CONSOLE_LEVELS } from "../src/events.js";
import { expectValidEvents } from "./schema-helper.js";

type ConsoleFunction = (...args: unknown[]) => void;
const saved = Object.fromEntries(CONSOLE_LEVELS.map((level) => [level, console[level]])) as Record<string, ConsoleFunction>;
let page: Record<string, ReturnType<typeof vi.fn>>;
let collector: ConsoleCollector;

beforeEach(() => {
  // The page's own console functions, so restoration can be checked by identity.
  page = Object.fromEntries(CONSOLE_LEVELS.map((level) => [level, vi.fn()]));
  for (const level of CONSOLE_LEVELS) console[level] = page[level] as ConsoleFunction;
  collector = new ConsoleCollector(10);
});

afterEach(() => {
  // Restore the globals first, so a failed check cannot leak into later tests.
  const events = collector.collect();
  collector.stop();
  for (const level of CONSOLE_LEVELS) console[level] = saved[level] as ConsoleFunction;
  expectValidEvents(events);
});

describe("ConsoleCollector capture", () => {
  it("records every level as a v1 console event and still calls the page's console", () => {
    collector.start();
    for (const level of CONSOLE_LEVELS) console[level](`via ${level}`, 1);
    const events = collector.collect();
    expect(events.map((event) => event.level)).toEqual([...CONSOLE_LEVELS]);
    expect(events[0]).toMatchObject({ schemaVersion: 1, kind: "console", args: ["via log", 1] });
    for (const level of CONSOLE_LEVELS) expect(page[level]).toHaveBeenCalledWith(`via ${level}`, 1);
    const seqs = events.map((event) => event.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("emits valid events for captured values that carry a toJSON key", () => {
    collector.start();
    console.log({ toJSON: "data", a: 1 }, { toJSON: () => 1 }, Object.assign(new Error("hooked"), { toJSON: "x" }));
    const [event] = collector.collect();
    expect(event!.args).toMatchObject([{ toJSON: "data", a: 1 }, { toJSON: expect.any(String) }, { message: "hooked", toJSON: "x" }]);
    // afterEach validates it in both validators, before and after JSON.
  });

  it("serializes arguments under the closed set", () => {
    collector.start();
    const cyclic: Record<string, unknown> = { name: "test" };
    cyclic.self = cyclic;
    console.error(new Error("Test error"), cyclic, undefined, [[[[["five levels"]]]]]);
    const [error, object, missing, nested] = collector.collect()[0]!.args as [Record<string, unknown>, unknown, unknown, unknown];
    expect(error).toMatchObject({ name: "Error", message: "Test error" });
    expect(object).toEqual({ name: "test", self: "[Circular]" });
    expect(missing).toBe("undefined");
    expect(nested).toEqual([[[[["five levels"]]]]]);
  });

  it("keeps the newest maxSize events and supports maxSize 0", () => {
    collector.start();
    for (let index = 0; index < 15; index += 1) console.log(`Message ${index}`);
    const events = collector.collect();
    expect(events).toHaveLength(10);
    expect(events[0]!.args[0]).toBe("Message 5");
    expect(events[9]!.args[0]).toBe("Message 14");

    const none = new ConsoleCollector(0);
    none.start();
    console.log("dropped");
    none.stop();
    expect(none.size()).toBe(0);
    expect(() => new ConsoleCollector(-1)).toThrow(RangeError);
  });

  it("filters by time window", () => {
    const now = vi.spyOn(Date, "now");
    collector.start();
    for (const time of [1_000, 2_000, 3_000]) {
      now.mockReturnValue(time);
      console.log(`at ${time}`);
    }
    now.mockRestore();
    expect(collector.collect({ since: 2_000 }).map((event) => event.args[0])).toEqual(["at 2000", "at 3000"]);
    expect(collector.collect({ since: 1_500, until: 2_000 }).map((event) => event.args[0])).toEqual(["at 2000"]);
  });

  it("returns frozen events that callers cannot alter", () => {
    collector.start();
    console.log({ value: 1 });
    const [event] = collector.collect();
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event!.args[0])).toBe(true);
  });

  it("does not double-start, clears and reports size", () => {
    collector.start();
    collector.start();
    console.log("Test");
    expect(collector.size()).toBe(1);
    collector.clear();
    expect(collector.size()).toBe(0);
    expect(collector.collect()).toEqual([]);
  });

  it("does not recurse when serializing an argument logs", () => {
    collector.start();
    const noisy = {
      get value() {
        console.warn("getter ran");
        return 1;
      },
    };
    console.log(noisy);
    expect(collector.collect().map((event) => event.level)).toEqual(["log"]);
    expect(page.warn).toHaveBeenCalledWith("getter ran");
  });
});

describe("ConsoleCollector stop()", () => {
  it("restores exactly the functions it replaced", () => {
    collector.start();
    for (const level of CONSOLE_LEVELS) expect(console[level]).not.toBe(page[level]);
    collector.stop();
    for (const level of CONSOLE_LEVELS) expect(console[level]).toBe(page[level]);
    console.log("after stop");
    expect(collector.size()).toBe(0);
  });

  it("stays chained and inert when another library patched console after start()", () => {
    collector.start();
    const ours = console.info;
    const later = vi.fn(function (this: unknown, ...args: unknown[]) {
      return ours.apply(this, args);
    });
    console.info = later;

    collector.stop();
    expect(console.info).toBe(later);
    console.info("through the chain");
    expect(later).toHaveBeenCalledTimes(1);
    expect(page.info).toHaveBeenCalledTimes(1);
    expect(page.info).toHaveBeenCalledWith("through the chain");
    expect(collector.size()).toBe(0);

    // A new collector wraps the current chain and captures each call once.
    const next = new ConsoleCollector();
    next.start();
    console.info("captured once");
    expect(next.collect().map((event) => event.args)).toEqual([["captured once"]]);
    next.stop();
    expect(console.info).toBe(later);
    expect(page.info).toHaveBeenCalledTimes(2);
  });

  it("supports overlapping collectors stopped out of order", () => {
    const a = new ConsoleCollector();
    const b = new ConsoleCollector();
    a.start();
    b.start();
    a.stop();
    console.info("after first stop");
    expect(a.size()).toBe(0);
    expect(b.size()).toBe(1);
    b.stop();
    expect(console.info).toBe(page.info);
  });
});
