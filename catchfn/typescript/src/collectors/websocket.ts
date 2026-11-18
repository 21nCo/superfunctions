import { EVIDENCE_SCHEMA_VERSION, freezeEvent, takeSeq, type WebSocketEvidenceEvent } from "../events.js";
import { apply, attribute, intrinsic, listen, platform, platformRead, prototypeOf, UNREADABLE, type Intrinsic } from "../utils/platform.js";
import { redactUrl } from "../utils/redaction.js";
import { RingBuffer, assertCapacity, type CollectWindow } from "../utils/ring-buffer.js";
import { MAX_ENTRY_BYTES, truncateToBytes } from "../utils/serialization.js";
import { UNREAD_URL } from "./network.js";

/** What a socket listener or the `send` wrapper observed, already redacted. */
type Observation = Omit<WebSocketEvidenceEvent, "schemaVersion" | "kind" | "seq">;
type Listener = (observation: Observation) => void;

// The platform getters observation reads through, captured when this module
// loads: a getter the page patches later never runs on a socket or event.
const WEBSOCKET_PROTOTYPE = prototypeOf(platform.WebSocket);
// The `url` getter each prototype of the load-time WebSocket's chain passes
// to its sockets, also when the global was already a subclass at load.
const LOADED_URL_GETTERS = loadedUrlGetters();
const MESSAGE_EVENT_DATA = intrinsic(prototypeOf(platform.MessageEvent), "data");
const CLOSE_EVENT_PROTOTYPE = prototypeOf(platform.CloseEvent);
const CLOSE_EVENT_CODE = intrinsic(CLOSE_EVENT_PROTOTYPE, "code");
const CLOSE_EVENT_WAS_CLEAN = intrinsic(CLOSE_EVENT_PROTOTYPE, "wasClean");
const ARRAY_BUFFER_BYTE_LENGTH = intrinsic(prototypeOf(platform.ArrayBuffer), "byteLength");
const SHARED_ARRAY_BUFFER_BYTE_LENGTH = intrinsic(prototypeOf(platform.SharedArrayBuffer), "byteLength");
const TYPED_ARRAY_BYTE_LENGTH = intrinsic(Object.getPrototypeOf(Uint8Array.prototype) as object, "byteLength");
const DATA_VIEW_BYTE_LENGTH = intrinsic(prototypeOf(platform.DataView), "byteLength");
const BLOB_SIZE = intrinsic(prototypeOf(platform.Blob), "size");
const SIZE_GETTERS = [ARRAY_BUFFER_BYTE_LENGTH, SHARED_ARRAY_BUFFER_BYTE_LENGTH, TYPED_ARRAY_BYTE_LENGTH, DATA_VIEW_BYTE_LENGTH, BLOB_SIZE];

let listeners = new Set<Listener>();
let restore: (() => void) | undefined;

/** UTF-8 byte length of a string, as a socket sends it, without encoding it. */
function utf8Size(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4; // A surrogate pair.
      index += 1;
    } else bytes += 3; // Including a lone surrogate, sent as U+FFFD.
  }
  return bytes;
}

/**
 * Payload size in bytes: a string's UTF-8 length, or the size of an
 * `ArrayBuffer`, typed array, `DataView` or `Blob` through the captured
 * platform getters. The payload itself is never read or kept. Undefined for
 * anything else.
 */
function payloadSize(data: unknown): number | undefined {
  if (typeof data === "string") return utf8Size(data);
  for (const get of SIZE_GETTERS) {
    const size = platformRead(get, data);
    if (Number.isSafeInteger(size) && (size as number) >= 0) return size as number;
  }
  return undefined;
}

function captureUrl(url: unknown): string {
  return typeof url === "string" ? (truncateToBytes(redactUrl(url), MAX_ENTRY_BYTES) ?? "") : UNREAD_URL;
}

/**
 * A close event's attribute through the captured `CloseEvent` getter. On a
 * runtime without a global `CloseEvent` (Node 22), through the getter of the
 * event's own prototype, the platform's class there.
 */
function closeAttribute(get: Intrinsic | undefined, event: unknown, key: "code" | "wasClean"): unknown {
  if (get || typeof event !== "object" || event === null) return attribute(get, event, key);
  try {
    return attribute(intrinsic(Object.getPrototypeOf(event) as object, key), event, key);
  } catch {
    return UNREADABLE;
  }
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

/** The getter an own `url` accessor defines, undefined for an own data property; absent: null. */
function ownUrlGetter(prototype: object): Intrinsic | undefined | null {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "url");
  if (!descriptor) return null;
  return typeof descriptor.get === "function" ? (descriptor.get as Intrinsic) : undefined;
}

function loadedUrlGetters(): Map<object, Intrinsic | undefined> {
  const getters = new Map<object, Intrinsic | undefined>();
  if (!WEBSOCKET_PROTOTYPE) return getters;
  const chain = prototypeChain(WEBSOCKET_PROTOTYPE);
  let inherited: Intrinsic | undefined;
  // From the top down, so each prototype maps to the nearest getter at or above it.
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const prototype = chain[index] as object;
    const own = ownUrlGetter(prototype);
    if (own !== null) inherited = own;
    getters.set(prototype, inherited);
  }
  return getters;
}

/**
 * The `url` getter sockets of the global class inherit: the one captured at
 * load once the chain reaches a prototype of the load-time WebSocket's chain,
 * else the nearest own getter (a WebSocket defined or replaced after load).
 */
function urlGetterOf(chain: object[]): Intrinsic | undefined {
  for (const prototype of chain) {
    if (LOADED_URL_GETTERS.has(prototype)) return LOADED_URL_GETTERS.get(prototype);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "url");
    if (descriptor) return typeof descriptor.get === "function" ? (descriptor.get as Intrinsic) : undefined;
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

function subscribe(listener: Listener): () => void {
  if (listeners.size === 0) {
    listeners = new Set();
    const current = listeners;
    const emit = (observation: Observation) => {
      for (const receive of current) {
        try {
          receive(observation);
        } catch {
          /* Capture must never change the page's sockets. */
        }
      }
    };
    // Sockets constructed while these wrappers are installed, with their redacted URL.
    const sockets = new WeakMap<object, string>();
    const cleanups: Array<() => void> = [];
    const Original = platform.WebSocket;
    const prototype = prototypeOf(Original);

    if (typeof Original === "function" && prototype) {
      // The getter captured when this module loaded, or, for a WebSocket
      // defined or replaced later, when the wrappers are installed.
      const chain = prototypeChain(prototype);
      const urlGetter = urlGetterOf(chain);

      const observe = (socket: object) => {
        const url = captureUrl(attribute(urlGetter, socket, "url"));
        sockets.set(socket, url);
        const on = (type: string, read: (event: unknown) => Partial<Observation>) =>
          listen(socket, type, (event) => {
            // A socket outlives stop(): its listeners stay attached but inert.
            if (current.size === 0) return;
            try {
              emit({ type: type as Observation["type"], url, timestamp: Date.now(), ...read(event) });
            } catch {
              /* Observation never raises into the socket's event dispatch. */
            }
          });
        on("open", () => ({}));
        on("message", (event) => {
          const size = payloadSize(attribute(MESSAGE_EVENT_DATA, event, "data"));
          return size === undefined ? { direction: "received" } : { direction: "received", size };
        });
        on("close", (event) => {
          const closed: Partial<Observation> = {};
          const code = closeAttribute(CLOSE_EVENT_CODE, event, "code");
          if (Number.isSafeInteger(code) && (code as number) >= 0) closed.code = code as number;
          const wasClean = closeAttribute(CLOSE_EVENT_WAS_CLEAN, event, "wasClean");
          if (typeof wasClean === "boolean") closed.wasClean = wasClean;
          return closed;
        });
        on("error", () => ({}));
      };

      // The constructor stays the page's own class behind a Proxy, so its
      // statics, prototype, `instanceof` and subclassing keep working. The
      // listeners go on before the page can add its own.
      const wrapper = new Proxy(Original, {
        construct(target, args, newTarget) {
          const socket = Reflect.construct(target, args, newTarget) as object;
          if (current.size > 0) {
            try {
              observe(socket);
            } catch {
              /* An unreadable socket is returned unobserved. */
            }
          }
          return socket;
        },
      });
      platform.WebSocket = wrapper;
      cleanups.push(() => {
        if (platform.WebSocket === wrapper) platform.WebSocket = Original;
      });

      // The send() sockets of the global class actually inherit, wrapped where it is defined.
      const sendOwner = sendOwnerOf(chain);
      if (sendOwner) {
        const { owner, original: originalSend } = sendOwner;
        const send = function (this: unknown, ...args: unknown[]) {
          if (current.size === 0) return apply(originalSend, this, args);
          const timestamp = Date.now();
          // A send() the platform rejects (a connecting socket) throws here
          // and is not recorded.
          const result = apply(originalSend, this, args);
          try {
            const url = typeof this === "object" && this !== null ? sockets.get(this) : undefined;
            if (url !== undefined) {
              const size = payloadSize(args[0]);
              emit(size === undefined ? { type: "message", url, timestamp, direction: "sent" } : { type: "message", url, timestamp, direction: "sent", size });
            }
          } catch {
            /* Observation never changes what send() returns. */
          }
          return result;
        };
        owner.send = send;
        cleanups.push(() => {
          if (owner.send === send) owner.send = originalSend;
        });
      }
    }

    // Restore only what we replaced and still own; a wrapper another library
    // installed over ours keeps ours in its chain, inert once `current` empties.
    restore = () => {
      for (const cleanup of cleanups) cleanup();
    };
  }
  const current = listeners;
  current.add(listener);
  return () => {
    current.delete(listener);
    if (current === listeners && current.size === 0) {
      restore?.();
      restore = undefined;
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
