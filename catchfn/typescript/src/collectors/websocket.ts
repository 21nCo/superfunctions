import { EVIDENCE_SCHEMA_VERSION, freezeEvent, takeSeq, type WebSocketEvidenceEvent } from "../events.js";
import { apply, attribute, intrinsic, listen, platform, platformRead, prototypeOf, unlisten, UNREADABLE, type Intrinsic } from "../utils/platform.js";
import { redactUrl } from "../utils/redaction.js";
import { RingBuffer, assertCapacity, type CollectWindow } from "../utils/ring-buffer.js";
import { MAX_ENTRY_BYTES, truncateToBytes } from "../utils/serialization.js";
import { UNREAD_URL } from "./network.js";

/** What a socket listener or the `send` wrapper observed, already redacted. */
type Observation = Omit<WebSocketEvidenceEvent, "schemaVersion" | "kind" | "seq">;
type Listener = (observation: Observation) => void;
type Deliver = (observation: Observation) => void;

// The platform getters observation reads through, captured when this module
// loads: a getter the page patches later never runs on a socket or event.
const WEBSOCKET_PROTOTYPE = prototypeOf(platform.WebSocket);
// The `url` and `readyState` getters each prototype of the load-time
// WebSocket's chain passes to its sockets, also when the global was already
// a subclass at load.
const LOADED_GETTERS = { url: loadedGetters("url"), readyState: loadedGetters("readyState") };
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const MESSAGE_EVENT_DATA = intrinsic(prototypeOf(platform.MessageEvent), "data");
const CLOSE_EVENT_PROTOTYPE = prototypeOf(platform.CloseEvent);
const CLOSE_EVENT_CODE = intrinsic(CLOSE_EVENT_PROTOTYPE, "code");
const CLOSE_EVENT_WAS_CLEAN = intrinsic(CLOSE_EVENT_PROTOTYPE, "wasClean");
// The binary data a socket sends as it is, each recognized by its brand-checked
// size getter. Anything else, a bare SharedArrayBuffer included, the platform
// converts to a string first.
const ARRAY_BUFFER_BYTE_LENGTH = intrinsic(prototypeOf(platform.ArrayBuffer), "byteLength");
const TYPED_ARRAY_BYTE_LENGTH = intrinsic(Object.getPrototypeOf(Uint8Array.prototype) as object, "byteLength");
const DATA_VIEW_BYTE_LENGTH = intrinsic(prototypeOf(platform.DataView), "byteLength");
const BLOB_SIZE = intrinsic(prototypeOf(platform.Blob), "size");
const BINARY_SIZE_GETTERS = [ARRAY_BUFFER_BYTE_LENGTH, TYPED_ARRAY_BYTE_LENGTH, DATA_VIEW_BYTE_LENGTH, BLOB_SIZE];
// Sizing a string never runs a String.prototype method the page replaced.
const CHAR_CODE_AT = intrinsic(String.prototype, "charCodeAt", "value") as Intrinsic;
// `isTrusted`: an unforgeable own accessor of each browser event, else Event.prototype's.
const EVENT_IS_TRUSTED = isTrustedGetter();
// A browser window or worker fires its socket events trusted, so an untrusted
// one there was dispatched by the page. Node dispatches its own socket events
// untrusted, so there `isTrusted` tells nothing.
const TRUSTED_EVENTS_ONLY = EVENT_IS_TRUSTED !== undefined && (typeof platform.Window === "function" || typeof platform.WorkerGlobalScope === "function");

let listeners = new Set<Listener>();
let restore: (() => void) | undefined;

/** UTF-8 byte length of a string, as a socket sends it, without encoding it. */
function utf8Size(value: string): number {
  const codeAt = (index: number) => apply(CHAR_CODE_AT, value, [index]) as number;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = codeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && (codeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4; // A surrogate pair.
      index += 1;
    } else bytes += 3; // Including a lone surrogate, sent as U+FFFD.
  }
  return bytes;
}

/**
 * The size in bytes of an `ArrayBuffer`, typed array, `DataView` or `Blob`,
 * read through the captured platform getters, whose brand checks run no page
 * code. Undefined for anything else.
 */
function binarySize(data: unknown): number | undefined {
  for (const get of BINARY_SIZE_GETTERS) {
    const size = platformRead(get, data);
    if (Number.isSafeInteger(size) && (size as number) >= 0) return size as number;
  }
  return undefined;
}

/** Payload size in bytes: a string's UTF-8 length or a binary payload's size. The payload itself is never kept. */
function payloadSize(data: unknown): number | undefined {
  return typeof data === "string" ? utf8Size(data) : binarySize(data);
}

function isTrustedGetter(): Intrinsic | undefined {
  try {
    const Event = platform.Event as (new (type: string) => object) | undefined;
    return (typeof Event === "function" ? intrinsic(new Event("probe"), "isTrusted") : undefined) ?? intrinsic(prototypeOf(Event), "isTrusted");
  } catch {
    return undefined;
  }
}

function captureUrl(url: unknown): string {
  return typeof url === "string" ? (truncateToBytes(redactUrl(url), MAX_ENTRY_BYTES) ?? "") : UNREAD_URL;
}

/**
 * The prototypes a socket of the global class inherits from, nearest first,
 * up to (not including) `Object.prototype`: a page or library may install a
 * subclass of the platform WebSocket, whose own prototype has no `url` or `send`.
 */
function prototypeChain(prototype: object): object[] {
  const chain: object[] = [];
  for (let current: object | null = prototype; current && current !== Object.prototype && chain.length < 32; current = Object.getPrototypeOf(current) as object | null) {
    chain.push(current);
  }
  return chain;
}

type SocketAttribute = "url" | "readyState";

/** The getter an own accessor defines, undefined for an own data property; absent: null. */
function ownGetter(prototype: object, key: SocketAttribute): Intrinsic | undefined | null {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  if (!descriptor) return null;
  return typeof descriptor.get === "function" ? (descriptor.get as Intrinsic) : undefined;
}

function loadedGetters(key: SocketAttribute): Map<object, Intrinsic | undefined> {
  const getters = new Map<object, Intrinsic | undefined>();
  if (!WEBSOCKET_PROTOTYPE) return getters;
  const chain = prototypeChain(WEBSOCKET_PROTOTYPE);
  let inherited: Intrinsic | undefined;
  // From the top down, so each prototype maps to the nearest getter at or above it.
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const prototype = chain[index] as object;
    const own = ownGetter(prototype, key);
    if (own !== null) inherited = own;
    getters.set(prototype, inherited);
  }
  return getters;
}

/**
 * The getter sockets of the global class inherit: the one captured at load
 * once the chain reaches a prototype of the load-time WebSocket's chain, else
 * the nearest own getter (a WebSocket defined or replaced after load).
 */
function getterOf(chain: object[], key: SocketAttribute): Intrinsic | undefined {
  for (const prototype of chain) {
    const loaded = LOADED_GETTERS[key];
    if (loaded.has(prototype)) return loaded.get(prototype);
    const own = ownGetter(prototype, key);
    if (own !== null) return own;
  }
  return undefined;
}

/** The prototype that owns the `send` sockets of the global class inherit, when it is a writable method. */
function sendOwnerOf(chain: object[]): { owner: Record<string, unknown>; original: Intrinsic } | undefined {
  for (const prototype of chain) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "send");
    if (!descriptor) continue;
    if (typeof descriptor.value !== "function" || !descriptor.writable) return undefined;
    return { owner: prototype as Record<string, unknown>, original: descriptor.value as Intrinsic };
  }
  return undefined;
}

/**
 * Installs the constructor and `send` wrappers for one subscription set.
 * Every target is resolved before anything is replaced, and a failure part
 * way through undoes what was installed. Returns the restore function, which
 * runs each cleanup on its own so one that throws never blocks the rest.
 */
function install(current: Set<Listener>): (() => void) | undefined {
  /** The receivers subscribed when an observation began, minus any that stopped since. */
  const receivers = (): Deliver => {
    const snapshot = [...current];
    return (observation) => {
      for (const receive of snapshot) {
        if (!current.has(receive)) continue;
        try {
          receive(observation);
        } catch {
          /* Capture must never change the page's sockets. */
        }
      }
    };
  };
  const cleanups: Array<() => void> = [];
  // False once restored or rolled back: a wrapper left installed (one another
  // library chained, or one a failed restore left) then observes nothing.
  let active = true;
  const live = () => active && current.size > 0;
  const undo = () => {
    active = false;
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch {
        /* Each restore is attempted on its own. */
      }
    }
  };
  try {
    const Original = platform.WebSocket;
    const prototype = prototypeOf(Original);
    if (typeof Original !== "function" || !prototype) return undefined;
    // The getter captured when this module loaded, or, for a WebSocket
    // defined or replaced later, when the wrappers are installed.
    const chain = prototypeChain(prototype);
    const urlGetter = getterOf(chain, "url");
    const readyStateGetter = getterOf(chain, "readyState");
    const sendOwner = sendOwnerOf(chain);
    const readyState = (socket: unknown): unknown => {
      try {
        return attribute(readyStateGetter, socket, "readyState");
      } catch {
        return UNREADABLE;
      }
    };

    // Sockets constructed while these wrappers are installed, with their redacted URL.
    const sockets = new WeakMap<object, string>();
    // The observed sockets, held weakly so the collector never keeps one alive
    // (a refused socket may never fire close), and how to detach each one's
    // listeners: its own after its close, all of them on the last stop().
    const observed = new Set<WeakRef<object>>();
    const detachOf = new WeakMap<object, () => void>();
    const forget = new FinalizationRegistry<WeakRef<object>>((ref) => observed.delete(ref));
    cleanups.push(() => {
      for (const ref of [...observed]) {
        const socket = ref.deref();
        if (socket) detachOf.get(socket)?.();
      }
      observed.clear();
    });

    const observe = (socket: object) => {
      const url = captureUrl(attribute(urlGetter, socket, "url"));
      // Redacting the URL can run page code that stops the last collector.
      if (!live()) return;
      const added: Array<[string, (event: unknown) => void]> = [];
      const ref = new WeakRef(socket);
      const detach = () => {
        observed.delete(ref);
        forget.unregister(ref);
        for (const [type, callback] of added) unlisten(socket, type, callback);
      };
      // Discoverable by cleanup before any listener goes on, in case adding
      // one runs page code that stops the last collector.
      observed.add(ref);
      detachOf.set(socket, detach);
      forget.register(socket, ref, ref);
      let opened = false;
      // `read` returns undefined for an event the platform did not fire.
      const on = (type: Observation["type"], read: (event: unknown) => Partial<Observation> | undefined) => {
        const callback = (event: unknown) => {
          if (!live()) return;
          const deliver = receivers();
          let fields: Partial<Observation> | undefined;
          try {
            if (TRUSTED_EVENTS_ONLY && platformRead(EVENT_IS_TRUSTED, event) !== true) return;
            fields = read(event);
            if (fields) deliver({ type, url, timestamp: Date.now(), ...fields });
          } catch {
            /* Observation never raises into the socket's event dispatch. */
          } finally {
            // The platform's close is the socket's last event: nothing keeps it observed after that.
            if (type === "close" && fields) detach();
          }
        };
        if (!live()) return;
        // Owned before the attempt: an addEventListener that registers it and
        // then throws still leaves it for detach() to remove.
        added.push([type, callback]);
        listen(socket, type, callback);
      };
      // The platform fires open once, on a socket that is open by then; a
      // listener before ours (a subclass's own) may already have closed it,
      // which leaves it closing, never closed, while the event dispatches.
      on("open", () => {
        const state = readyState(socket);
        if (opened || (state !== OPEN && state !== CLOSING)) return undefined;
        opened = true;
        return {};
      });
      on("message", (event) => {
        const data = attribute(MESSAGE_EVENT_DATA, event, "data");
        // A message event the page dispatches itself is not a received message.
        if (MESSAGE_EVENT_DATA && data === UNREADABLE) return undefined;
        const size = payloadSize(data);
        return size === undefined ? { direction: "received" } : { direction: "received", size };
      });
      on("close", (event) => {
        // The platform fires close on a closed socket, as a CloseEvent where the runtime has that class.
        if (readyState(socket) !== CLOSED) return undefined;
        const closed: Partial<Observation> = {};
        const code = attribute(CLOSE_EVENT_CODE, event, "code");
        if (CLOSE_EVENT_CODE && code === UNREADABLE) return undefined;
        if (Number.isSafeInteger(code) && (code as number) >= 0) closed.code = code as number;
        const wasClean = attribute(CLOSE_EVENT_WAS_CLEAN, event, "wasClean");
        if (typeof wasClean === "boolean") closed.wasClean = wasClean;
        return closed;
      });
      on("error", () => ({}));
      if (!live()) {
        detach(); // Stopped part way: remove what went on after the cleanup ran.
        return;
      }
      sockets.set(socket, url);
    };

    // The constructor stays the page's own class behind a Proxy, so its
    // statics, prototype, `instanceof` and subclassing keep working. The
    // listeners go on before the page can add its own.
    const wrapper = new Proxy(Original, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as object;
        if (live()) {
          try {
            observe(socket);
          } catch {
            /* An unreadable socket is returned unobserved. */
          }
        }
        return socket;
      },
    });

    // The send() sockets of the global class actually inherit, wrapped where it is defined.
    const send = sendOwner
      ? function (this: unknown, ...args: unknown[]) {
          // A socket constructed while no collector ran gets the plain send.
          const url = live() && typeof this === "object" && this !== null ? sockets.get(this) : undefined;
          if (url === undefined) return apply(sendOwner.original, this, args);
          const timestamp = Date.now();
          const deliver = receivers();
          // Strings and binary data are sent as they are. The platform
          // converts any other object to a string first, which can run page
          // code that closes the socket and so discards the data. That
          // conversion is done here instead, once and exactly as the platform
          // does it, and the send gets the resulting string: the socket's state
          // after it then tells whether the data is sent.
          let data = args[0];
          const binary = binarySize(data);
          if (args.length > 0 && binary === undefined && ((typeof data === "object" && data !== null) || typeof data === "function")) {
            data = `${data as unknown as string}`; // Throws where the platform's conversion throws.
            args[0] = data;
          }
          // Only a send() on an open socket transmits: the platform throws
          // while connecting and discards the data once closing or closed. A
          // send that closes the socket after transmitting still sent it.
          const openBefore = readyState(this) === OPEN;
          const result = apply(sendOwner.original, this, args);
          if (openBefore) {
            try {
              const size = typeof data === "string" ? utf8Size(data) : binary;
              deliver(size === undefined ? { type: "message", url, timestamp, direction: "sent" } : { type: "message", url, timestamp, direction: "sent", size });
            } catch {
              /* Observation never changes what send() returns. */
            }
          }
          return result;
        }
      : undefined;

    // Restore only what we replaced and still own; a wrapper another library
    // installed over ours keeps ours in its chain, inert once `current` empties.
    // Each rollback is registered before its write, so a write that takes
    // effect and then throws is undone too.
    cleanups.push(() => {
      if (platform.WebSocket === wrapper) platform.WebSocket = Original;
    });
    platform.WebSocket = wrapper;
    if (sendOwner && send) {
      const { owner, original } = sendOwner;
      cleanups.push(() => {
        if (owner.send === send) owner.send = original;
      });
      owner.send = send;
    }
  } catch {
    undo(); // A partly installed collector would record only some events.
    return undefined;
  }
  return undo;
}

function subscribe(listener: Listener): () => void {
  const first = listeners.size === 0;
  if (first) listeners = new Set();
  const current = listeners;
  // Subscribed before installing: page code that installing runs (a
  // WebSocket getter) and that starts another collector joins this session.
  current.add(listener);
  if (first) restore = install(current);
  return () => {
    current.delete(listener);
    if (current === listeners && current.size === 0) {
      const undo = restore;
      restore = undefined;
      undo?.();
    }
  };
}

/**
 * Records the `open`, `message`, `close` and `error` events of WebSocket
 * connections as websocket evidence events in a bounded buffer: messages in
 * both directions with their size in bytes, never their payload, and the
 * socket URL redacted with `redactUrl`. Only sockets constructed while a
 * collector runs are observed. Runs on its own, without a reporter or server.
 */
export class WebSocketCollector {
  private readonly events: RingBuffer<WebSocketEvidenceEvent>;
  private unsubscribe?: () => void;

  constructor(maxSize = 100) {
    assertCapacity(maxSize);
    this.events = new RingBuffer(maxSize);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribe((observation) => {
      if (this.events.capacity === 0) return;
      const event: WebSocketEvidenceEvent = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        kind: "websocket",
        seq: takeSeq(),
        timestamp: observation.timestamp,
        type: observation.type,
        url: observation.url,
      };
      // Optional fields are omitted, never present as undefined.
      if (observation.direction !== undefined) event.direction = observation.direction;
      if (observation.size !== undefined) event.size = observation.size;
      if (observation.code !== undefined) event.code = observation.code;
      if (observation.wasClean !== undefined) event.wasClean = observation.wasClean;
      this.events.push(freezeEvent(event));
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Captured events, oldest first, optionally limited to a time window. */
  collect(window?: CollectWindow): WebSocketEvidenceEvent[] {
    return this.events.query(window);
  }

  clear(): void {
    this.events.clear();
  }

  size(): number {
    return this.events.size;
  }
}
