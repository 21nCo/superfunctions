import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketCollector } from "../src/collectors/websocket.js";
import { expectValidEvents } from "./schema-helper.js";

const platform = globalThis as Record<string, unknown>;
const savedWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");

// Node 22 has no global CloseEvent; a stand-in with the same getters.
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
const CloseEventClass = (platform.CloseEvent as typeof StandInCloseEvent | undefined) ?? StandInCloseEvent;

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
  // As the platform: throws while connecting, discards the data once closing or closed.
  send(data: unknown): void {
    if (this.readyState === 0) throw new DOMException("still connecting", "InvalidStateError");
    if (this.readyState === 1) this.sent.push(data);
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

  it("ignores message and close events the page dispatches on a socket itself", () => {
    collector.start();
    const socket = openSocket("wss://example.com/forged");
    socket.dispatchEvent(Object.assign(new Event("message"), { data: "forged" }));
    if (platform.CloseEvent) socket.dispatchEvent(Object.assign(new Event("close"), { code: 4000, wasClean: true }));
    socket.serverSends("real");
    expect(collector.collect().map(({ type, size }) => ({ type, size }))).toEqual([{ type: "message", size: 4 }]);
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
    try {
      collector.stop();
      if (savedWebSocket) Object.defineProperty(globalThis, "WebSocket", savedWebSocket);
      collector.start();
      const Native = platform.WebSocket as typeof WebSocket;
      const socket = new Native(`ws://127.0.0.1:${port}/socket?token=test-socket-token`);
      socket.addEventListener("open", () => {
        socket.send("ü-text");
        socket.send(new Uint8Array([1, 2, 3]));
      });
      const closed = await new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
      expect(closed.code).toBe(1000);
      socket.send("discarded after close"); // The platform drops it; nothing is recorded.
      // Node's WebSocket reports a refused handshake with an error event only.
      const refused = new Native(`ws://127.0.0.1:${port}/refused`);
      await new Promise((resolve) => refused.addEventListener("error", resolve));

      const events = collector.collect();
      const summary = events.map(({ type, direction, size, code, wasClean }) => ({ type, direction, size, code, wasClean }));
      expect(summary).toEqual([
        { type: "open", direction: undefined, size: undefined, code: undefined, wasClean: undefined },
        { type: "message", direction: "sent", size: 7, code: undefined, wasClean: undefined },
        { type: "message", direction: "sent", size: 3, code: undefined, wasClean: undefined },
        { type: "message", direction: "received", size: 5, code: undefined, wasClean: undefined },
        { type: "message", direction: "received", size: 5, code: undefined, wasClean: undefined },
        { type: "close", direction: undefined, size: undefined, code: 1000, wasClean: true },
        { type: "error", direction: undefined, size: undefined, code: undefined, wasClean: undefined },
      ]);
      expect(events[0]!.url).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:${port}/socket\\?token=`));
      expect(JSON.stringify(events)).not.toContain("test-socket-token");
      expect(events[6]!.url).toBe(`ws://127.0.0.1:${port}/refused`);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
