import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketCollector } from "../src/collectors/websocket.js";
import { expectValidEvents } from "./schema-helper.js";

const platform = globalThis as Record<string, unknown>;
const savedWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");

// Node 22 has no global CloseEvent: a stand-in with the same branded getters,
// installed before the collector loads, as a browser's would be.
const { StandInCloseEvent, runtimeCloseEvent } = vi.hoisted(() => {
  class StandInCloseEvent extends Event {
    readonly #code: number;
    readonly #wasClean: boolean;
    constructor(type: string, init: { code: number; wasClean: boolean }) {
      super(type);
      this.#code = init.code;
      this.#wasClean = init.wasClean;
    }
    get code(): number {
      return this.#code;
    }
    get wasClean(): boolean {
      return this.#wasClean;
    }
  }
  const runtimeCloseEvent = (globalThis as Record<string, unknown>).CloseEvent as typeof StandInCloseEvent | undefined;
  if (!runtimeCloseEvent) (globalThis as Record<string, unknown>).CloseEvent = StandInCloseEvent;
  return { StandInCloseEvent, runtimeCloseEvent };
});
const CloseEventClass = runtimeCloseEvent ?? StandInCloseEvent;

/** The page's WebSocket: an event target the test drives from the "server" side. */
class PageSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly sent: unknown[] = [];
  readyState = 0;
  readonly #url: string;
  constructor(url: string | URL) {
    super();
    this.#url = String(url);
  }
  get url(): string {
    return this.#url;
  }
  // As the platform: converts other data to a string first, then throws while
  // connecting and discards the data once closing or closed.
  send(data: unknown): void {
    const binary = data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data instanceof Blob;
    const value = typeof data === "object" && data !== null && !binary ? String(data) : data;
    if (this.readyState === 0) throw new DOMException("still connecting", "InvalidStateError");
    if (this.readyState === 1) this.sent.push(value);
  }
  close(): void {
    this.readyState = 2;
  }
  serverOpens(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  serverSends(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  serverFails(): void {
    this.dispatchEvent(new Event("error"));
  }
  serverCloses(code: number, wasClean: boolean): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEventClass("close", { code, wasClean }));
  }
}
const pageSend = PageSocket.prototype.send;

const openSocket = (url: string) => new (platform.WebSocket as typeof PageSocket)(url);

let collector: WebSocketCollector;

beforeEach(() => {
  platform.WebSocket = PageSocket;
  collector = new WebSocketCollector(20);
});

afterEach(() => {
  const events = collector.collect();
  collector.stop();
  if (savedWebSocket) Object.defineProperty(globalThis, "WebSocket", savedWebSocket);
  else delete platform.WebSocket;
  PageSocket.prototype.send = pageSend;
  expectValidEvents(events);
});

/** The collector loaded while PageSocket is the global, so PageSocket's send is the platform's to it. */
async function loadOverPageSocket() {
  platform.WebSocket = PageSocket;
  vi.resetModules();
  return import("../src/collectors/websocket.js");
}

/** The collector loaded with listener methods that record each add and remove. */
async function loadRecordingListeners(hooks: { onAdd?: () => void } = {}) {
  const added: Array<[unknown, string, unknown]> = [];
  const removed: Array<[unknown, string, unknown]> = [];
  const { addEventListener, removeEventListener } = EventTarget.prototype;
  EventTarget.prototype.addEventListener = function (this: EventTarget, ...args: Parameters<EventTarget["addEventListener"]>) {
    added.push([this, args[0], args[1]]);
    const result = addEventListener.apply(this, args);
    hooks.onAdd?.();
    return result;
  };
  EventTarget.prototype.removeEventListener = function (this: EventTarget, ...args: Parameters<EventTarget["removeEventListener"]>) {
    removed.push([this, args[0], args[1]]);
    return removeEventListener.apply(this, args);
  };
  vi.resetModules();
  try {
    const fresh = await import("../src/collectors/websocket.js"); // Captures the recording methods.
    return { fresh, added, removed };
  } finally {
    EventTarget.prototype.addEventListener = addEventListener;
    EventTarget.prototype.removeEventListener = removeEventListener;
  }
}

describe("WebSocketCollector", () => {
  it("records open, messages both ways with their size, error and close, never a payload", () => {
    collector.start();
    const socket = openSocket("wss://example.com/live");
    socket.serverOpens();
    socket.send("héllo"); // é is two bytes in UTF-8.
    socket.serverSends("payload-text-🙂");
    socket.serverFails();
    socket.serverCloses(1011, false);
    const events = collector.collect();
    expect(events.map(({ type, direction, size }) => ({ type, direction, size }))).toEqual([
      { type: "open", direction: undefined, size: undefined },
      { type: "message", direction: "sent", size: 6 },
      { type: "message", direction: "received", size: 17 },
      { type: "error", direction: undefined, size: undefined },
      { type: "close", direction: undefined, size: undefined },
    ]);
    expect(events[4]).toMatchObject({ code: 1011, wasClean: false });
    for (const event of events) expect(event).toMatchObject({ schemaVersion: 1, kind: "websocket", url: "wss://example.com/live" });
    expect(events.every((event) => !("code" in event) || event.type === "close")).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/héllo|payload-text/);
    expect(socket.sent).toEqual(["héllo"]); // The page's send() still ran with its own data.
    const seqs = events.map((event) => event.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("records the socket URL through redactUrl", () => {
    collector.start();
    openSocket("wss://example.com/socket?token=secret").serverOpens();
    const [event] = collector.collect();
    expect(event!.url).toMatch(/^wss:\/\/example\.com\/socket\?token=/);
    expect(event!.url).not.toContain("secret");
  });

  it("measures binary payloads in bytes", () => {
    collector.start();
    const socket = openSocket("wss://example.com/binary");
    socket.serverOpens();
    socket.send(new ArrayBuffer(8));
    socket.send(new Uint8Array(new ArrayBuffer(16), 4, 5));
    socket.send(new DataView(new ArrayBuffer(10), 2, 3));
    socket.send(new Blob(["abcd"]));
    socket.serverSends(new ArrayBuffer(12));
    socket.serverSends(new Blob(["ab"]));
    socket.serverSends({ unknown: "shape" });
    const sizes = collector.collect().filter((event) => event.type === "message").map((event) => event.size);
    expect(sizes).toEqual([8, 5, 3, 4, 12, 2, undefined]);
  });

  it("does not record a send() the socket rejects", () => {
    collector.start();
    const socket = openSocket("wss://example.com/early");
    expect(() => socket.send("too early")).toThrow("still connecting");
    expect(collector.collect()).toEqual([]);
  });

  it("does not record a send() whose data a closing or closed socket discards", () => {
    collector.start();
    const socket = openSocket("wss://example.com/closing");
    socket.serverOpens();
    socket.close();
    socket.send("while closing");
    socket.serverCloses(1000, true);
    socket.send("after close");
    expect(socket.sent).toEqual([]);
    expect(collector.collect().map((event) => event.type)).toEqual(["open", "close"]);
  });

  it("records a send() through a library's own send that closes the socket after transmitting", () => {
    class SendAndClose extends PageSocket {
      override send(data: unknown): void {
        super.send(data);
        this.close();
      }
    }
    platform.WebSocket = SendAndClose;
    collector.start();
    const socket = openSocket("wss://example.com/send-and-close");
    socket.serverOpens();
    socket.send("last");
    expect(socket.sent).toEqual(["last"]);
    expect(collector.collect().map(({ type, size }) => ({ type, size }))).toEqual([
      { type: "open", size: undefined },
      { type: "message", size: 4 },
    ]);
  });

  it("adds no socket listeners when redacting the URL stops the last collector", async () => {
    const { fresh, added, removed } = await loadRecordingListeners();
    const reentrant = new fresh.WebSocketCollector(5);
    const PlatformURL = URL;
    globalThis.URL = class extends PlatformURL {
      constructor(...args: ConstructorParameters<typeof URL>) {
        super(...args);
        reentrant.stop();
      }
    } as typeof URL;
    try {
      reentrant.start();
      const socket = openSocket("wss://example.com/reentrant");
      socket.serverOpens();
      expect(added.filter(([target]) => target === socket)).toEqual([]);
      expect(removed).toEqual([]);
    } finally {
      globalThis.URL = PlatformURL;
      reentrant.stop();
    }
    expect(platform.WebSocket).toBe(PageSocket);
    expect(reentrant.collect()).toEqual([]);
  });

  it("removes a listener whose addEventListener registered it and then threw, on close and on the last stop()", async () => {
    const hooks: { onAdd?: () => void } = {};
    const { fresh, added, removed } = await loadRecordingListeners(hooks);
    const first = new fresh.WebSocketCollector(5);
    const second = new fresh.WebSocketCollector(5);
    hooks.onAdd = () => {
      throw new Error("registered, then threw");
    };
    try {
      first.start();
      second.start();
      const closed = openSocket("wss://example.com/closed");
      const abandoned = openSocket("wss://example.com/abandoned");
      const ours = (socket: unknown) => added.filter(([target]) => target === socket).map(([, type, listener]) => [type, listener]);
      const gone = (socket: unknown) => removed.filter(([target]) => target === socket).map(([, type, listener]) => [type, listener]);
      expect(ours(closed)).toHaveLength(4);
      closed.serverOpens();
      closed.serverCloses(1000, true);
      expect(gone(closed)).toEqual(expect.arrayContaining(ours(closed)));
      expect(first.collect().map((event) => event.type)).toEqual(["open", "close"]);
      first.stop(); // Overlapping: the other collector still runs.
      expect(gone(abandoned)).toEqual([]);
      second.stop();
      expect(ours(abandoned)).toHaveLength(4);
      expect(gone(abandoned)).toEqual(expect.arrayContaining(ours(abandoned)));
    } finally {
      hooks.onAdd = undefined;
      first.stop();
      second.stop();
    }
  });

  it("joins one session when installing starts another collector, and restores everything on the last stop()", () => {
    let global: unknown = PageSocket;
    let reads = 0;
    const inner = new WebSocketCollector(5);
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      get() {
        reads += 1;
        if (reads === 1) inner.start(); // Page code run by installing.
        return global;
      },
      set(value) {
        global = value;
      },
    });
    try {
      collector.start();
      expect(global).not.toBe(PageSocket);
      const socket = new (global as typeof PageSocket)("wss://example.com/reentrant-install");
      socket.serverOpens();
      socket.send("once");
      expect(socket.sent).toEqual(["once"]);
      for (const each of [collector, inner]) {
        expect(each.collect().map(({ type, size }) => ({ type, size }))).toEqual([
          { type: "open", size: undefined },
          { type: "message", size: 4 },
        ]);
      }
      inner.stop();
      collector.stop();
      expect(global).toBe(PageSocket);
      expect(PageSocket.prototype.send).toBe(pageSend);
    } finally {
      inner.stop();
    }
  });

  /** Makes the global WebSocket an accessor whose first read runs `hook` (page code run by installing). */
  function hookFirstRead(hook: () => void): { readonly value: unknown } {
    const state = { value: PageSocket as unknown };
    let reads = 0;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      get() {
        reads += 1;
        if (reads === 1) hook();
        return state.value;
      },
      set(value) {
        state.value = value;
      },
    });
    return state;
  }

  const sentSizes = (each: WebSocketCollector) => each.collect().filter((event) => event.type === "message").map(({ size }) => size);

  it("subscribes once when installing reenters start() of the same collector, and one stop() restores everything", () => {
    const global = hookFirstRead(() => collector.start());
    collector.start();
    const socket = new (global.value as typeof PageSocket)("wss://example.com/reenter");
    socket.serverOpens();
    socket.send("x");
    expect(socket.sent).toEqual(["x"]);
    expect(collector.collect().map(({ type, size }) => ({ type, size }))).toEqual([
      { type: "open", size: undefined },
      { type: "message", size: 1 },
    ]);
    collector.stop();
    expect(global.value).toBe(PageSocket);
    expect(PageSocket.prototype.send).toBe(pageSend);
  });

  it("cancels a start() that stop() interrupts while installing: nothing stays installed and a later start() captures once", () => {
    const global = hookFirstRead(() => collector.stop());
    collector.start();
    expect(global.value).toBe(PageSocket);
    expect(PageSocket.prototype.send).toBe(pageSend);
    const unobserved = new (global.value as typeof PageSocket)("wss://example.com/cancelled");
    unobserved.serverOpens();
    unobserved.send("lost");
    expect(collector.collect()).toEqual([]);
    collector.start();
    const socket = new (global.value as typeof PageSocket)("wss://example.com/after-cancel");
    socket.serverOpens();
    socket.send("once");
    expect(sentSizes(collector)).toEqual([4]);
    collector.stop();
    expect(global.value).toBe(PageSocket);
    expect(PageSocket.prototype.send).toBe(pageSend);
  });

  it("keeps the session of a collector that joined while a stopped install was pending, and restarts once", () => {
    const other = new WebSocketCollector(5);
    const global = hookFirstRead(() => {
      other.start();
      collector.stop();
      collector.start(); // Restarted while the first start() is still installing.
    });
    try {
      collector.start();
      expect(global.value).not.toBe(PageSocket);
      const socket = new (global.value as typeof PageSocket)("wss://example.com/joined");
      socket.serverOpens();
      socket.send("ab");
      expect(sentSizes(collector)).toEqual([2]);
      expect(sentSizes(other)).toEqual([2]);
      collector.stop();
      expect(global.value).not.toBe(PageSocket); // other still runs.
      socket.send("c");
      expect(sentSizes(collector)).toEqual([2]);
      expect(sentSizes(other)).toEqual([2, 1]);
      other.stop();
      expect(global.value).toBe(PageSocket);
      expect(PageSocket.prototype.send).toBe(pageSend);
      expectValidEvents(other.collect());
    } finally {
      other.stop();
    }
  });

  /** Makes the global WebSocket an accessor that runs `onRead` before each read and `onWrite` before each write. */
  function hookAccess(hooks: { onRead?: () => void; onWrite?: () => void }): { readonly value: unknown } {
    const state = { value: PageSocket as unknown };
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      get() {
        hooks.onRead?.();
        return state.value;
      },
      set(value) {
        hooks.onWrite?.();
        state.value = value;
      },
    });
    return state;
  }

  for (const via of ["getter", "setter"] as const) {
    it(`installs a session the global's ${via} starts during stop() over the restored constructor, and its stop() restores everything`, () => {
      const other = new WebSocketCollector(5);
      let armed = false;
      const restart = () => {
        if (!armed) return;
        armed = false;
        collector.start(); // The same collector, restarted by page code during its own stop().
        other.start();
      };
      const global = hookAccess(via === "getter" ? { onRead: restart } : { onWrite: restart });
      try {
        collector.start();
        const wrapper = global.value;
        expect(wrapper).not.toBe(PageSocket);
        armed = true;
        collector.stop();
        expect(armed).toBe(false);
        expect(global.value).not.toBe(PageSocket);
        expect(global.value).not.toBe(wrapper);
        const socket = new (global.value as typeof PageSocket)("wss://example.com/restarted");
        socket.serverOpens();
        socket.send("x");
        expect(socket.sent).toEqual(["x"]);
        for (const each of [collector, other]) expect(each.collect().map(({ type, size }) => [type, size])).toEqual([["open", undefined], ["message", 1]]);
        collector.stop();
        other.stop();
        expect(global.value).toBe(PageSocket);
        expect(PageSocket.prototype.send).toBe(pageSend);
        socket.send("after");
        expect(other.collect()).toHaveLength(2);
        expectValidEvents(other.collect());
      } finally {
        other.stop();
      }
    });
  }

  it("never nests installs: a restart during a deferred install keeps one session, and the last stop() restores everything", () => {
    let step = 0;
    const global = hookAccess({
      onWrite: () => {
        if (step === 1) {
          step = 2;
          collector.start(); // During stop()'s restore: deferred.
        }
      },
      onRead: () => {
        if (step === 2) {
          step = 3;
          collector.stop(); // During the deferred install, which reads the global first.
          collector.start();
        }
      },
    });
    collector.start();
    step = 1;
    collector.stop();
    expect(step).toBe(3);
    const socket = new (global.value as typeof PageSocket)("wss://example.com/nested");
    socket.serverOpens();
    socket.send("x");
    expect(collector.collect().map(({ type, size }) => [type, size])).toEqual([["open", undefined], ["message", 1]]);
    collector.stop();
    expect(global.value).toBe(PageSocket);
    expect(PageSocket.prototype.send).toBe(pageSend);
  });

  it("never captures a socket built while a stop() during installing had cancelled it; a restart and an overlapping collector each capture once", () => {
    const other = new WebSocketCollector(5);
    let value: unknown = PageSocket;
    let cancelled: PageSocket | undefined;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      get: () => value,
      set(next) {
        if (next !== PageSocket && !cancelled) {
          collector.stop(); // Page code in the global's setter, while the first start() installs.
          cancelled = new (next as typeof PageSocket)("wss://example.com/cancelled"); // Through the incoming wrapper.
          collector.start();
        }
        value = next;
      },
    });
    try {
      collector.start();
      other.start();
      cancelled!.serverOpens();
      cancelled!.send("lost");
      cancelled!.serverSends("lost");
      cancelled!.serverCloses(1000, true);
      expect(cancelled!.sent).toEqual(["lost"]);
      const socket = new (value as typeof PageSocket)("wss://example.com/restarted");
      socket.serverOpens();
      socket.send("ab");
      collector.stop();
      socket.send("c");
      expect(collector.collect().map(({ type, size }) => [type, size])).toEqual([["open", undefined], ["message", 2]]);
      expect(sentSizes(other)).toEqual([2, 1]);
      other.stop();
      expect(value).toBe(PageSocket);
      expect(PageSocket.prototype.send).toBe(pageSend);
      expectValidEvents(other.collect());
    } finally {
      other.stop();
    }
  });

  it("excludes a send already under way from a collector a hook inside it restarts", () => {
    collector.start();
    const socket = openSocket("wss://example.com/pending");
    socket.serverOpens();
    PageSocket.prototype.send = function (this: PageSocket, data: unknown) {
      collector.stop();
      collector.start(); // A new subscription, after this send began.
      return pageSend.call(this, data);
    };
    collector.stop();
    collector.start(); // Wraps the hooked send.
    const hooked = openSocket("wss://example.com/pending");
    hooked.serverOpens();
    hooked.send("x");
    expect(hooked.sent).toEqual(["x"]);
    expect(sentSizes(collector)).toEqual([]);
  });

  it("installs the last of a long run of restarts made while installing, without deepening the stack", () => {
    let value: unknown = PageSocket;
    let restarts = 0;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      get: () => value,
      set(next) {
        value = next;
        if (next !== PageSocket && restarts < 12_000) {
          restarts += 1;
          collector.stop();
          collector.start();
        }
      },
    });
    collector.start();
    expect(restarts).toBe(12_000);
    expect(value).not.toBe(PageSocket);
    const socket = new (value as typeof PageSocket)("wss://example.com/last");
    socket.serverOpens();
    socket.send("x");
    expect(sentSizes(collector)).toEqual([1]);
    collector.stop();
    expect(value).toBe(PageSocket);
    expect(PageSocket.prototype.send).toBe(pageSend);
  });

  it("installs the last of a long run of starts during restores and stops during installs, without deepening the stack", () => {
    let value: unknown = PageSocket;
    let steps = 0;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      get: () => value,
      set(next) {
        value = next;
        if (steps >= 12_000) return;
        steps += 1;
        if (next === PageSocket) collector.start(); // During a restore: deferred until it finishes.
        else collector.stop(); // During that install: undone once it finishes.
      },
    });
    collector.start(); // Each install stops it and each restore restarts it, 12000 times; the last start installs.
    expect(steps).toBe(12_000);
    expect(value).not.toBe(PageSocket);
    const socket = new (value as typeof PageSocket)("wss://example.com/alternating");
    socket.serverOpens();
    socket.send("x");
    expect(sentSizes(collector)).toEqual([1]);
    collector.stop();
    expect(value).toBe(PageSocket);
    expect(PageSocket.prototype.send).toBe(pageSend);
  });

  it("transmits a Blob Proxy whose trap closes the socket exactly as without the collector", () => {
    const transmit = () => {
      const socket = openSocket("wss://example.com/proxy-blob");
      socket.serverOpens();
      const blob = new Proxy(new Blob(["abc"]), {
        get(target, key) {
          if (typeof key === "symbol") socket.close(); // Sizing the data runs this trap.
          return Reflect.get(target, key) as unknown;
        },
      });
      socket.send(blob);
      return socket.sent.length;
    };
    const without = transmit();
    collector.start();
    expect(transmit()).toBe(without);
    expect(without).toBe(1);
  });

  it("drops an observation whose clock gives no valid v1 timestamp, keeping the send and the socket's events", async () => {
    const realNow = Date.now;
    let clock: () => unknown = realNow;
    Date.now = () => clock() as number;
    vi.resetModules();
    let fresh: typeof import("../src/collectors/websocket.js");
    try {
      fresh = await import("../src/collectors/websocket.js"); // Captures the clock above.
    } finally {
      Date.now = realNow;
    }
    const timed = new fresh.WebSocketCollector(20);
    timed.start();
    try {
      const page = vi.fn();
      const exercise = () => {
        const socket = openSocket("wss://example.com/clock");
        socket.addEventListener("message", page);
        socket.serverOpens();
        socket.send("x");
        socket.serverSends("y");
        socket.serverFails();
        socket.serverCloses(1000, true);
        return socket.sent;
      };
      const invalid: Array<() => unknown> = [() => Number.NaN, () => 1.5, () => -1, () => "1700000000000", () => Number.POSITIVE_INFINITY, () => 2 ** 53];
      for (const each of [...invalid, () => { throw new Error("clock"); }]) {
        clock = each;
        expect(exercise()).toEqual(["x"]);
      }
      expect(timed.collect()).toEqual([]);
      expect(page).toHaveBeenCalledTimes(invalid.length + 1);
      clock = () => 1_700_000_000_000;
      expect(exercise()).toEqual(["x"]);
      expect(timed.collect().map(({ type, direction, timestamp }) => [type, direction, timestamp])).toEqual([
        ["open", undefined, 1_700_000_000_000],
        ["message", "sent", 1_700_000_000_000],
        ["message", "received", 1_700_000_000_000],
        ["error", undefined, 1_700_000_000_000],
        ["close", undefined, 1_700_000_000_000],
      ]);
      expectValidEvents(timed.collect());
    } finally {
      timed.stop();
    }
  });

  it("records a binary size only when it is a nonnegative safe integer, keeping the event", () => {
    collector.start();
    const socket = openSocket("wss://example.com/sizes");
    socket.serverOpens();
    // A Proxy of a Blob can make the platform's own size getter report any number.
    const fooled = (size: number) =>
      new Proxy(new Blob(["abc"]), { get: (target, key) => (typeof key === "symbol" && key !== Symbol.toPrimitive && key !== Symbol.toStringTag ? size : Reflect.get(target, key)) });
    const invalid = [2.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53];
    for (const size of invalid) socket.send(fooled(size));
    for (const size of invalid) socket.serverSends(fooled(size));
    socket.send(new Uint8Array(3));
    socket.serverSends(new Blob(["abcd"]));
    socket.send("é");
    const messages = collector.collect().filter((event) => event.type === "message");
    expect(messages.map(({ direction, size }) => [direction, size])).toEqual([
      ...invalid.map(() => ["sent", undefined]),
      ...invalid.map(() => ["received", undefined]),
      ["sent", 3],
      ["received", 4],
      ["sent", 2],
    ]);
    for (const event of messages) expect(event).not.toHaveProperty("size", undefined);
    expectValidEvents(messages);
  });

  it("removes every listener when adding one stops the last collector", async () => {
    const hooks: { onAdd?: () => void } = {};
    const { fresh, added, removed } = await loadRecordingListeners(hooks);
    const interrupted = new fresh.WebSocketCollector(5);
    hooks.onAdd = () => {
      hooks.onAdd = undefined;
      interrupted.stop();
    };
    interrupted.start();
    const socket = openSocket("wss://example.com/interrupted");
    const ours = added.filter(([target]) => target === socket).map(([, type, listener]) => [type, listener]);
    const gone = removed.filter(([target]) => target === socket).map(([, type, listener]) => [type, listener]);
    expect(ours.length).toBeGreaterThan(0);
    expect(gone).toEqual(expect.arrayContaining(ours));
    expect(platform.WebSocket).toBe(PageSocket);
    expect(socket.readyState).toBe(0); // Left as it was.
  });

  it("never runs a String.prototype method the page replaced when sizing, and sends as without the collector", () => {
    collector.start();
    const socket = openSocket("wss://example.com/sizing");
    socket.serverOpens();
    const { charCodeAt } = String.prototype;
    let calls = 0;
    // A non-throwing hook that would close the socket before the send if it ran.
    String.prototype.charCodeAt = function (this: string, index: number) {
      calls += 1;
      socket.close();
      return charCodeAt.call(this, index);
    };
    try {
      socket.send("hello");
    } finally {
      String.prototype.charCodeAt = charCodeAt;
    }
    expect(calls).toBe(0);
    expect(socket.sent).toEqual(["hello"]);
    expect(collector.collect().map(({ type, direction, size }) => ({ type, direction, size }))).toEqual([
      { type: "open", direction: undefined, size: undefined },
      { type: "message", direction: "sent", size: 5 },
    ]);
  });

  it("runs no replaced Number or Array method before the send, and a throwing one never stops it", () => {
    // Armed until the page's send runs: what runs after it cannot change the transmission.
    let armed = false;
    PageSocket.prototype.send = function (this: PageSocket, data: unknown) {
      armed = false;
      pageSend.call(this, data);
    };
    collector.start();
    const socket = openSocket("wss://example.com/predicates");
    socket.serverOpens();
    const { isSafeInteger } = Number;
    const iterator = Array.prototype[Symbol.iterator];
    let calls = 0;
    let closes = false;
    const before = () => {
      if (!armed) return;
      calls += 1;
      if (closes) socket.close();
      else throw new Error("patched");
    };
    Number.isSafeInteger = (value: unknown) => (before(), isSafeInteger(value));
    Array.prototype[Symbol.iterator] = function (this: unknown[]) {
      before();
      return iterator.call(this);
    };
    try {
      for (const closing of [false, true]) {
        closes = closing;
        for (const data of ["text", new Uint8Array(3), { toString: () => "object" }]) {
          armed = true;
          socket.send(data);
        }
      }
    } finally {
      Number.isSafeInteger = isSafeInteger;
      Array.prototype[Symbol.iterator] = iterator;
    }
    expect(calls).toBe(0);
    expect(socket.sent).toEqual(["text", new Uint8Array(3), "object", "text", new Uint8Array(3), "object"]);
    expect(collector.collect().filter((event) => event.type === "message").map(({ size }) => size)).toEqual([4, 3, undefined, 4, 3, undefined]);
  });

  it("passes a send() on a socket it does not observe straight through, without sizing or converting", () => {
    const early = new PageSocket("wss://example.com/early");
    early.serverOpens();
    collector.start();
    const { charCodeAt } = String.prototype;
    let calls = 0;
    String.prototype.charCodeAt = function (this: string, index: number) {
      calls += 1;
      return charCodeAt.call(this, index);
    };
    let conversions = 0;
    const data = { toString: () => `converted ${(conversions += 1)}` };
    try {
      (platform.WebSocket as typeof PageSocket).prototype.send.call(early, "hi");
      (platform.WebSocket as typeof PageSocket).prototype.send.call(early, data);
    } finally {
      String.prototype.charCodeAt = charCodeAt;
    }
    expect(calls).toBe(0);
    expect(conversions).toBe(1); // Only the page's send converted it.
    expect(early.sent).toEqual(["hi", "converted 1"]);
    expect(collector.collect()).toEqual([]);
  });

  it("does not record a send() whose data conversion closes the socket, and records one that converts, converting each once", async () => {
    const fresh = await loadOverPageSocket();
    const platformCollector = new fresh.WebSocketCollector(5);
    collector = platformCollector; // Stopped and its events validated after the test.
    collector.start();
    const socket = openSocket("wss://example.com/convert");
    socket.serverOpens();
    let conversions = 0;
    socket.send({ toString: () => `converted${(conversions += 1)}` });
    socket.send({
      toString: () => {
        conversions += 1;
        socket.close();
        return "discarded";
      },
    });
    expect(conversions).toBe(2); // Only the platform's send converted each.
    expect(socket.sent).toEqual(["converted1"]);
    expect(collector.collect().map(({ type, direction, size }) => ({ type, direction, size }))).toEqual([
      { type: "open", direction: undefined, size: undefined },
      { type: "message", direction: "sent", size: undefined },
    ]);
  });

  it("records converted data a library's send transmits and then closes the socket after, passing it the caller's object", () => {
    const received: unknown[] = [];
    PageSocket.prototype.send = function (this: PageSocket, data: unknown) {
      received.push(data);
      pageSend.call(this, data);
      this.close();
    };
    collector.start();
    const socket = openSocket("wss://example.com/library-close");
    socket.serverOpens();
    let conversions = 0;
    const data = { toString: () => ((conversions += 1), "hello") };
    socket.send(data);
    expect(received[0]).toBe(data);
    expect(conversions).toBe(1);
    expect(socket.sent).toEqual(["hello"]);
    // What a library's send makes of an object is its own: no size.
    const messages = collector.collect().filter((event) => event.type === "message");
    expect(messages.map(({ direction, size }) => ({ direction, size }))).toEqual([{ direction: "sent", size: undefined }]);
  });

  it("transmits what a library's send makes of an object exactly as without the collector", () => {
    const library = function (this: PageSocket, data: unknown) {
      pageSend.call(this, typeof data === "object" && data !== null ? JSON.stringify(data) : data);
    };
    const transmit = () => {
      const socket = openSocket("wss://example.com/json");
      socket.serverOpens();
      socket.send({ action: "ping" });
      socket.send("text");
      return socket.sent;
    };
    PageSocket.prototype.send = library;
    const without = transmit();
    collector.start();
    const withCollector = transmit();
    expect(without).toEqual(['{"action":"ping"}', "text"]);
    expect(withCollector).toEqual(without);
    expect(collector.collect().filter((event) => event.type === "message").map(({ size }) => size)).toEqual([undefined, 4]);
  });

  it("passes the caller's own object to the platform's send and to a library's installed before load", async () => {
    const received: unknown[] = [];
    const library = function (this: PageSocket, data: unknown) {
      received.push(data);
      pageSend.call(this, typeof data === "object" && data !== null && !(data instanceof Blob) ? JSON.stringify(data) : data);
    };
    PageSocket.prototype.send = library; // Before load: counted as the platform's.
    const fresh = await loadOverPageSocket();
    collector = new fresh.WebSocketCollector(5);
    collector.start();
    const socket = openSocket("wss://example.com/identity");
    socket.serverOpens();
    const object = { action: "ping" };
    const blob = new Blob(["ab"]);
    socket.send(object);
    socket.send(blob);
    expect(received[0]).toBe(object);
    expect(received[1]).toBe(blob);
    expect(socket.sent).toEqual(['{"action":"ping"}', blob]);
    expect(collector.collect().filter((event) => event.type === "message").map(({ size }) => size)).toEqual([undefined, 2]);
  });

  it("never sizes a bare SharedArrayBuffer by its byteLength: the platform's send converts it to a string", async () => {
    // A send other than the platform's: unconverted, recorded without a size.
    collector.start();
    const socket = openSocket("wss://example.com/shared");
    socket.serverOpens();
    socket.send(new SharedArrayBuffer(1024) as unknown as ArrayBuffer);
    expect(socket.sent).toEqual(["[object SharedArrayBuffer]"]);
    expect(collector.collect().filter((event) => event.type === "message").map(({ size }) => size)).toEqual([undefined]);
    collector.stop();
    // The platform's send: still recorded without a size.
    const fresh = await loadOverPageSocket();
    collector = new fresh.WebSocketCollector(5);
    collector.start();
    const platformSocket = openSocket("wss://example.com/shared-platform");
    platformSocket.serverOpens();
    platformSocket.send(new SharedArrayBuffer(1024) as unknown as ArrayBuffer);
    platformSocket.send(new ArrayBuffer(8));
    expect(platformSocket.sent).toEqual(["[object SharedArrayBuffer]", new ArrayBuffer(8)]);
    expect(collector.collect().filter((event) => event.type === "message").map(({ size }) => size)).toEqual([undefined, 8]);
  });

  it("ignores message and close events the page dispatches on a socket itself", () => {
    collector.start();
    const socket = openSocket("wss://example.com/forged");
    socket.dispatchEvent(Object.assign(new Event("message"), { data: "forged" }));
    socket.readyState = 3; // Even on a closed socket, a close event must be the platform's.
    socket.dispatchEvent(Object.assign(new Event("close"), { code: 4000, wasClean: true }));
    socket.readyState = 1;
    socket.serverSends("real");
    expect(collector.collect().map(({ type, size }) => ({ type, size }))).toEqual([{ type: "message", size: 4 }]);
  });

  it("ignores an open the socket's state contradicts and a close on a socket still open", () => {
    collector.start();
    const socket = openSocket("wss://example.com/state");
    socket.dispatchEvent(new Event("open")); // Still connecting.
    socket.serverOpens();
    socket.dispatchEvent(new Event("open")); // The platform fires open once.
    socket.dispatchEvent(new CloseEventClass("close", { code: 4000, wasClean: true })); // Still open.
    socket.serverSends("ab"); // Still observed: the forged close did not detach it.
    expect(collector.collect().map(({ type, size }) => ({ type, size }))).toEqual([
      { type: "open", size: undefined },
      { type: "message", size: 2 },
    ]);
  });

  it("without a platform CloseEvent class, records a close without code and wasClean and never runs the event's getters", async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "CloseEvent");
    delete platform.CloseEvent;
    vi.resetModules();
    try {
      const fresh = await import("../src/collectors/websocket.js");
      const bare = new fresh.WebSocketCollector(5);
      let invoked = 0;
      class PageCloseEvent extends Event {
        get code(): number {
          invoked += 1;
          return 4000;
        }
        get wasClean(): boolean {
          invoked += 1;
          return true;
        }
      }
      bare.start();
      try {
        const socket = openSocket("wss://example.com/bare");
        socket.readyState = 3;
        socket.dispatchEvent(new PageCloseEvent("close"));
      } finally {
        bare.stop();
      }
      expect(invoked).toBe(0);
      expect(bare.collect().map(({ type, code, wasClean }) => ({ type, code, wasClean }))).toEqual([{ type: "close", code: undefined, wasClean: undefined }]);
    } finally {
      if (saved) Object.defineProperty(globalThis, "CloseEvent", saved);
    }
  });

  it("records the open of a socket whose class's own open listener, added first, closes it", () => {
    class ClosingSocket extends PageSocket {
      constructor(url: string) {
        super(url);
        this.addEventListener("open", () => this.close());
      }
    }
    platform.WebSocket = ClosingSocket;
    collector.start();
    const socket = openSocket("wss://example.com/closes-on-open");
    socket.serverOpens();
    expect(socket.readyState).toBe(2);
    socket.dispatchEvent(new Event("open")); // Still once.
    expect(collector.collect().map((event) => event.type)).toEqual(["open"]);
  });

  it("in a browser, ignores every socket event the page dispatches itself", async () => {
    platform.Window = class Window {};
    vi.resetModules();
    try {
      const fresh = await import("../src/collectors/websocket.js");
      const browser = new fresh.WebSocketCollector(10);
      browser.start();
      try {
        const socket = openSocket("wss://example.com/untrusted");
        socket.serverOpens();
        socket.serverSends("forged");
        socket.serverFails();
        socket.send("abc"); // A send() is not an event: still recorded.
        socket.serverCloses(1000, true);
      } finally {
        browser.stop();
      }
      expect(browser.collect().map(({ type, direction, size }) => ({ type, direction, size }))).toEqual([{ type: "message", direction: "sent", size: 3 }]);
      expectValidEvents(browser.collect());
    } finally {
      delete platform.Window;
    }
  });

  it("keeps the page's class behind the wrapper: instanceof, statics and subclasses", () => {
    collector.start();
    const Wrapped = platform.WebSocket as typeof PageSocket;
    expect(Wrapped).not.toBe(PageSocket);
    expect(Wrapped.OPEN).toBe(1);
    expect(Wrapped.prototype).toBe(PageSocket.prototype);
    class AppSocket extends Wrapped {}
    const socket = new AppSocket("wss://example.com/sub");
    expect(socket).toBeInstanceOf(PageSocket);
    expect(socket).toBeInstanceOf(AppSocket);
    socket.serverOpens();
    expect(collector.collect().map((event) => event.type)).toEqual(["open"]);
  });

  it("restores the constructor and send() on stop() and leaves earlier sockets inert", () => {
    collector.start();
    collector.start(); // A second start() installs nothing more.
    const before = openSocket("wss://example.com/before");
    before.serverOpens();
    collector.stop();
    expect(platform.WebSocket).toBe(PageSocket);
    expect(PageSocket.prototype.send).toBe(pageSend);
    before.send("after stop");
    before.serverSends("after stop");
    const after = openSocket("wss://example.com/after");
    after.serverOpens();
    expect(collector.collect().map((event) => event.type)).toEqual(["open"]);
    // A restart observes new sockets only.
    collector.start();
    before.serverSends("old socket");
    openSocket("wss://example.com/restart").serverOpens();
    expect(collector.collect().map((event) => event.url)).toEqual(["wss://example.com/before", "wss://example.com/restart"]);
  });

  it("leaves a wrapper another library installed after start() in place, ours inert inside it", () => {
    collector.start();
    const ours = platform.WebSocket as typeof PageSocket;
    const theirs = class extends ours {};
    platform.WebSocket = theirs;
    collector.stop();
    expect(platform.WebSocket).toBe(theirs);
    openSocket("wss://example.com/chained").serverOpens();
    expect(collector.collect()).toEqual([]);
  });

  it("observes a global subclass installed before start() through the members it inherits", () => {
    class LibrarySocket extends PageSocket {} // Own prototype has no url and no send.
    platform.WebSocket = LibrarySocket;
    collector.start();
    const socket = openSocket("wss://example.com/library?token=secret");
    socket.serverOpens();
    socket.send("abc");
    collector.stop();
    expect(platform.WebSocket).toBe(LibrarySocket);
    expect(PageSocket.prototype.send).toBe(pageSend);
    expect(Object.hasOwn(LibrarySocket.prototype, "send")).toBe(false);
    const events = collector.collect();
    expect(events.map(({ type, direction, size }) => ({ type, direction, size }))).toEqual([
      { type: "open", direction: undefined, size: undefined },
      { type: "message", direction: "sent", size: 3 },
    ]);
    for (const event of events) expect(event.url).toMatch(/^wss:\/\/example\.com\/library\?token=(?!secret)/);
  });

  it("observes a global subclass that was installed before catchfn loaded", async () => {
    class EarlySocket extends PageSocket {}
    platform.WebSocket = EarlySocket;
    vi.resetModules();
    const fresh = await import("../src/collectors/websocket.js");
    const early = new fresh.WebSocketCollector(5);
    early.start();
    try {
      const socket = openSocket("wss://example.com/early-load");
      socket.serverOpens();
      socket.send("abc");
    } finally {
      early.stop();
    }
    expect(platform.WebSocket).toBe(EarlySocket);
    const events = early.collect();
    expect(events.map(({ type, url, size }) => ({ type, url, size }))).toEqual([
      { type: "open", url: "wss://example.com/early-load", size: undefined },
      { type: "message", url: "wss://example.com/early-load", size: 3 },
    ]);
    expectValidEvents(events);
  });

  it("restarts under another library's subclass of the stopped wrapper with full capture", () => {
    collector.start();
    const theirs = class extends (platform.WebSocket as typeof PageSocket) {};
    platform.WebSocket = theirs;
    collector.stop();
    collector.start();
    const socket = openSocket("wss://example.com/restarted");
    socket.serverOpens();
    socket.send("abcd");
    socket.serverSends("xy");
    const events = collector.collect();
    expect(events.map(({ type, direction, size }) => ({ type, direction, size }))).toEqual([
      { type: "open", direction: undefined, size: undefined },
      { type: "message", direction: "sent", size: 4 },
      { type: "message", direction: "received", size: 2 },
    ]);
    expect(events.every((event) => event.url === "wss://example.com/restarted")).toBe(true);
  });

  it("lets overlapping collectors each see only what happened while they ran", () => {
    const other = new WebSocketCollector(20);
    collector.start();
    const socket = openSocket("wss://example.com/shared");
    socket.serverOpens();
    other.start();
    socket.serverSends("x");
    collector.stop();
    socket.serverCloses(1000, true);
    other.stop();
    expect(collector.collect().map((event) => event.type)).toEqual(["open", "message"]);
    expect(other.collect().map((event) => event.type)).toEqual(["message", "close"]);
    expectValidEvents(other.collect());
  });

  it("detaches its socket listeners on close and on the last stop(), keeping the page's listeners and sockets", async () => {
    const { fresh, added, removed } = await loadRecordingListeners();
    const first = new fresh.WebSocketCollector(10);
    const second = new fresh.WebSocketCollector(10);
    const on = (socket: object) => added.filter(([target]) => target === socket).map(([, type, listener]) => `${type}:${added.findIndex(([, , other]) => other === listener)}`);
    const off = (socket: object) => removed.filter(([target]) => target === socket).map(([, type, listener]) => `${type}:${added.findIndex(([, , other]) => other === listener)}`);
    first.start();
    second.start();
    const kept = openSocket("wss://example.com/kept");
    const pageMessages: unknown[] = [];
    kept.addEventListener("message", (event) => pageMessages.push((event as MessageEvent).data));
    kept.serverOpens();
    const done = openSocket("wss://example.com/done");
    done.serverOpens();
    done.serverCloses(1000, true);
    expect(on(done)).toHaveLength(4);
    expect(off(done).sort()).toEqual(on(done).sort()); // A closed socket is released at once.
    first.stop();
    expect(off(kept)).toEqual([]); // Another collector still runs.
    kept.serverSends("a");
    second.stop();
    expect(on(kept)).toHaveLength(4);
    expect(off(kept).sort()).toEqual(on(kept).sort());
    second.start();
    kept.serverSends("b"); // A restart does not observe earlier sockets.
    second.stop();
    expect(kept.readyState).toBe(1); // Never closed by the collector.
    expect(pageMessages).toEqual(["a", "b"]);
    expect(first.collect().map((event) => event.url)).toEqual(["wss://example.com/kept", "wss://example.com/done", "wss://example.com/done"]);
    expect(second.collect().map(({ type, url }) => `${type} ${url}`)).toEqual([
      "open wss://example.com/kept",
      "open wss://example.com/done",
      "close wss://example.com/done",
      "message wss://example.com/kept",
    ]);
  });

  it("installs nothing when the global cannot be replaced or its prototype cannot be read, and never throws from start()", () => {
    Object.defineProperty(globalThis, "WebSocket", { value: PageSocket, writable: false, configurable: true });
    expect(() => collector.start()).not.toThrow();
    expect(platform.WebSocket).toBe(PageSocket);
    expect(PageSocket.prototype.send).toBe(pageSend);
    collector.stop();

    const Unreadable = function () {} as unknown as { prototype: object };
    Unreadable.prototype = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("descriptor trap");
        },
      }
    );
    Object.defineProperty(globalThis, "WebSocket", { value: Unreadable, writable: true, configurable: true });
    expect(() => collector.start()).not.toThrow();
    expect(platform.WebSocket).toBe(Unreadable);
    collector.stop();
  });

  it("rolls back the constructor when wrapping send() fails part way", () => {
    const LockedSend = class extends PageSocket {};
    Object.setPrototypeOf(
      LockedSend.prototype,
      new Proxy(PageSocket.prototype, {
        set() {
          throw new Error("set trap");
        },
      })
    );
    platform.WebSocket = LockedSend;
    expect(() => collector.start()).not.toThrow();
    expect(platform.WebSocket).toBe(LockedSend);
    expect(PageSocket.prototype.send).toBe(pageSend);
  });

  it("undoes a write that takes effect and then throws, and leaves a wrapper it cannot remove inert", () => {
    let stored: unknown = PageSocket;
    let writes = 0;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      get: () => stored,
      set: (value: unknown) => {
        writes += 1;
        if (writes === 1) stored = value; // Takes effect, then throws; later writes are refused.
        throw new Error("locked binding");
      },
    });
    expect(() => collector.start()).not.toThrow();
    expect(platform.WebSocket).not.toBe(PageSocket); // The rollback could not remove it...
    expect(PageSocket.prototype.send).toBe(pageSend);
    const socket = openSocket("wss://example.com/failed-install");
    socket.serverOpens();
    socket.send("abc");
    expect(collector.collect()).toEqual([]); // ...but it observes nothing.

    collector.stop();
    stored = PageSocket;
    const target = Object.create(PageSocket.prototype, { send: { value: pageSend, writable: true, configurable: true } }) as Record<string, unknown>;
    const MutatingSend = class extends PageSocket {};
    Object.setPrototypeOf(
      MutatingSend.prototype,
      new Proxy(target, {
        set(object, key, value) {
          object[key as string] = value; // Takes effect, then throws.
          throw new Error("set trap");
        },
      })
    );
    Object.defineProperty(globalThis, "WebSocket", { value: MutatingSend, writable: true, configurable: true });
    expect(() => collector.start()).not.toThrow();
    expect(platform.WebSocket).toBe(MutatingSend);
    expect(target.send).toBe(pageSend);
  });

  it("never keeps an observed socket alive, also one that fails without a close event", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    collector.start();
    const ref = (() => {
      const socket = openSocket("wss://example.com/refused");
      socket.readyState = 3;
      socket.serverFails(); // As Node 22 reports a refused handshake: error, no close.
      return new WeakRef(socket);
    })();
    for (let attempt = 0; attempt < 10 && ref.deref(); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      gc();
    }
    expect(ref.deref()).toBeUndefined();
    expect(collector.collect().map((event) => event.type)).toEqual(["error"]);
  });

  it("attempts each restore on its own and clears its state when one throws", () => {
    let stored: unknown = PageSocket;
    let failRestore = true;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      get: () => stored,
      set: (value: unknown) => {
        if (value === PageSocket && failRestore) {
          failRestore = false;
          throw new Error("locked binding");
        }
        stored = value;
      },
    });
    collector.start();
    const wrapper = platform.WebSocket;
    collector.stop(); // The constructor restore throws.
    expect(platform.WebSocket).toBe(wrapper); // Left in place, inert.
    expect(PageSocket.prototype.send).toBe(pageSend); // Restored all the same.
    collector.start(); // A fresh installation, not a stale one.
    expect(PageSocket.prototype.send).not.toBe(pageSend);
    const socket = openSocket("wss://example.com/again");
    socket.serverOpens();
    socket.send("abc");
    collector.stop();
    expect(platform.WebSocket).toBe(wrapper); // What this installation replaced.
    expect(PageSocket.prototype.send).toBe(pageSend);
    expect(collector.collect().map(({ type, size }) => ({ type, size }))).toEqual([
      { type: "open", size: undefined },
      { type: "message", size: 3 },
    ]);

    // And the other way round: a send() restore that throws leaves the constructor restored.
    const LockedRestore = class extends PageSocket {};
    const target = Object.create(PageSocket.prototype, { send: { value: pageSend, writable: true, configurable: true } }) as Record<string, unknown>;
    Object.setPrototypeOf(
      LockedRestore.prototype,
      new Proxy(target, {
        set(object, key, value) {
          if (key === "send" && value === pageSend) throw new Error("set trap");
          object[key as string] = value;
          return true;
        },
      })
    );
    stored = LockedRestore;
    collector.start();
    collector.stop();
    expect(platform.WebSocket).toBe(LockedRestore);
  });

  it("keeps the newest maxSize events and supports maxSize 0", () => {
    const small = new WebSocketCollector(2);
    const none = new WebSocketCollector(0);
    small.start();
    none.start();
    const socket = openSocket("wss://example.com/many");
    socket.serverOpens();
    socket.send("a");
    socket.serverCloses(1000, true);
    small.stop();
    none.stop();
    expect(small.collect().map((event) => event.type)).toEqual(["message", "close"]);
    expect(none.size()).toBe(0);
  });
});

/** A minimal RFC 6455 server: echoes the size of each client frame back as text, then closes. */
function startServer(): Promise<{ server: Server; port: number; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.on("upgrade", (request, socket: Socket) => {
    sockets.add(socket);
    if (!request.url?.startsWith("/socket")) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    // The fixed GUID of RFC 6455 section 1.3, a published protocol constant.
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      // Client frames are masked and, in this test, shorter than 126 bytes.
      while (buffered.length >= 6 && buffered.length >= 6 + (buffered[1]! & 0x7f)) {
        const opcode = buffered[0]! & 0x0f;
        const length = buffered[1]! & 0x7f;
        buffered = buffered.subarray(6 + length);
        if (opcode === 0x8) {
          socket.end();
          return;
        }
        const reply = Buffer.from(`got ${length}`);
        socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
        if (opcode === 0x2) socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8])); // Close, code 1000.
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, sockets })));
}

describe.runIf(typeof savedWebSocket?.value === "function")("WebSocketCollector on the runtime's WebSocket", () => {
  it("records a real connection: open, a text and a binary message out, replies in, close, and a refused connection's error", async () => {
    const { server, port, sockets } = await startServer();
    // The collector as it loads on this runtime, without the test's stand-in CloseEvent.
    if (!runtimeCloseEvent) delete platform.CloseEvent;
    vi.resetModules();
    const fresh = await import("../src/collectors/websocket.js");
    const native = new fresh.WebSocketCollector(20);
    try {
      if (savedWebSocket) Object.defineProperty(globalThis, "WebSocket", savedWebSocket);
      native.start();
      const Native = platform.WebSocket as typeof WebSocket;
      const socket = new Native(`ws://127.0.0.1:${port}/socket?token=test-socket-token`);
      socket.addEventListener("open", () => {
        socket.send("ü-text");
        socket.send(new Uint8Array([1, 2, 3]));
      });
      const closed = await new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
      expect(closed.code).toBe(1000);
      socket.send("discarded after close"); // The platform drops it; nothing is recorded.
      // A refused handshake fires error; Node 24 and browsers then fire an
      // abnormal close, which Node 22 omits.
      const refused = new Native(`ws://127.0.0.1:${port}/refused`);
      await new Promise((resolve) => refused.addEventListener("error", resolve));
      await new Promise((resolve) => setTimeout(resolve, 50));
      native.stop();

      const events = native.collect();
      expectValidEvents(events);
      // Without a platform CloseEvent class (Node 22), the close code and
      // wasClean cannot be read through a verified getter and are omitted.
      const closeFields = (code: number, wasClean: boolean) => (runtimeCloseEvent ? { code, wasClean } : { code: undefined, wasClean: undefined });
      const summary = events.map(({ type, direction, size, code, wasClean }) => ({ type, direction, size, code, wasClean }));
      expect(summary.slice(0, 7)).toEqual([
        { type: "open", direction: undefined, size: undefined, code: undefined, wasClean: undefined },
        { type: "message", direction: "sent", size: 7, code: undefined, wasClean: undefined },
        { type: "message", direction: "sent", size: 3, code: undefined, wasClean: undefined },
        { type: "message", direction: "received", size: 5, code: undefined, wasClean: undefined },
        { type: "message", direction: "received", size: 5, code: undefined, wasClean: undefined },
        { type: "close", direction: undefined, size: undefined, ...closeFields(1000, true) },
        { type: "error", direction: undefined, size: undefined, code: undefined, wasClean: undefined },
      ]);
      const abnormalClose = { type: "close", direction: undefined, size: undefined, ...closeFields(1006, false) };
      expect([[], [abnormalClose]]).toContainEqual(summary.slice(7));
      expect(events[0]!.url).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:${port}/socket\\?token=`));
      expect(JSON.stringify(events)).not.toContain("test-socket-token");
      for (const event of events.slice(6)) expect(event.url).toBe(`ws://127.0.0.1:${port}/refused`);
    } finally {
      native.stop();
      if (!runtimeCloseEvent) platform.CloseEvent = StandInCloseEvent;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 20_000); // Node 22 takes about 4 s to finish the closing handshake.
});
