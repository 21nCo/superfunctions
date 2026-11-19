import { EVIDENCE_SCHEMA_VERSION, freezeEvent, takeSeq, type ErrorEvidenceEvent } from "../events.js";
import { apply, attribute, intrinsic, listen, now, platform, platformRead, prototypeOf, unlisten, UNREADABLE, type Intrinsic } from "../utils/platform.js";
import { redactUrl } from "../utils/redaction.js";
import { RingBuffer, assertCapacity, type CollectWindow } from "../utils/ring-buffer.js";
import { MAX_ENTRY_BYTES, serializeEntry, truncateToBytes, utf8Length, type SerializedValue } from "../utils/serialization.js";

/** What a window listener observed, already serialized and bounded. */
type Observation = Omit<ErrorEvidenceEvent, "schemaVersion" | "kind" | "seq">;
type Listener = (observation: Observation) => void;

// The ErrorEvent and PromiseRejectionEvent getters, captured when this module
// loads: a getter the page patches later never runs on a reported event.
const ERROR_EVENT_PROTOTYPE = prototypeOf(platform.ErrorEvent);
const ERROR_EVENT_MESSAGE = intrinsic(ERROR_EVENT_PROTOTYPE, "message");
const ERROR_EVENT_FILENAME = intrinsic(ERROR_EVENT_PROTOTYPE, "filename");
const ERROR_EVENT_LINENO = intrinsic(ERROR_EVENT_PROTOTYPE, "lineno");
const ERROR_EVENT_COLNO = intrinsic(ERROR_EVENT_PROTOTYPE, "colno");
const ERROR_EVENT_ERROR = intrinsic(ERROR_EVENT_PROTOTYPE, "error");
const REJECTION_EVENT_REASON = intrinsic(prototypeOf(platform.PromiseRejectionEvent), "reason");

let listeners = new Set<Listener>();
let restore: (() => void) | undefined;

function text(value: string): string {
  return truncateToBytes(value, MAX_ENTRY_BYTES) ?? "";
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false; // A throwing Symbol.hasInstance or Proxy trap.
  }
}

/** The JSON text of a serialized value, bounded, for the required `message`. */
function describe(value: SerializedValue): string {
  return text(typeof value === "string" ? value : JSON.stringify(value));
}

// A URL in a stack frame, from its scheme to the next whitespace.
const STACK_URL = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** Count of `character` in `text`. */
function count(text: string, character: string): number {
  return text.split(character).length - 1;
}

/**
 * A stack with each frame's script URL passed through `redactUrl`, keeping
 * the `:line:column` suffix, so it reveals no more than `filename` does. A
 * URL may hold parentheses itself (`app(1).js`); only the closing ones a V8
 * frame adds after it (`at f (url:1:2)`), which leave it unbalanced, are not
 * part of it.
 */
function redactStack(stack: string): string {
  return stack.replace(STACK_URL, (match) => {
    let url = match;
    let closing = "";
    while (url.endsWith(")") && count(url, ")") > count(url, "(")) {
      url = url.slice(0, -1);
      closing = ")" + closing;
    }
    // A frame ends in `:line:column` (or `:line`); any earlier digits are the URL's own.
    const position = /(?::\d+){1,2}$/.exec(url)?.[0] ?? "";
    return redactUrl(url.slice(0, url.length - position.length)) + position + closing;
  });
}

/**
 * The thrown value or rejection reason. An `Error` keeps its name, message
 * and stack (serialized as one entry, like a console argument); any other
 * value is serialized whole into `value`.
 */
function thrown(value: unknown): Pick<Observation, "message" | "name" | "stack" | "value"> {
  if (!isError(value)) {
    const serialized = serializeEntry(value);
    return { message: describe(serialized), value: serialized };
  }
  const serialized = serializeEntry(value);
  const record = typeof serialized === "object" && serialized !== null && !Array.isArray(serialized) ? serialized : {};
  const result: Pick<Observation, "message" | "name" | "stack"> = {
    message: typeof record.message === "string" ? record.message : "",
  };
  if (typeof record.name === "string") result.name = record.name;
  if (typeof record.stack === "string") {
    // Redaction can lengthen a URL; the stack keeps to what is left of the entry.
    const budget = MAX_ENTRY_BYTES - utf8Length(JSON.stringify({ name: result.name ?? "", message: result.message, stack: "" }));
    const stack = truncateToBytes(redactStack(record.stack), budget);
    if (stack !== undefined) result.stack = stack;
  }
  return result;
}

/**
 * An uncaught error, read from a platform `ErrorEvent` through the captured
 * getters. Any other `error` event reaching the window (one the page
 * dispatches itself) is not an uncaught error and yields undefined.
 */
function readError(event: unknown, timestamp: number): Observation | undefined {
  const message = platformRead(ERROR_EVENT_MESSAGE, event);
  if (message === UNREADABLE) return undefined;
  const error = platformRead(ERROR_EVENT_ERROR, event);
  const observation: Observation = {
    source: "error",
    timestamp,
    // A cross-origin "Script error." carries no error value at all.
    ...(error === null || error === undefined || error === UNREADABLE ? { message: "" } : thrown(error)),
  };
  // The browser's own text ("Uncaught Error: boom") when it has one.
  if (typeof message === "string" && message !== "") observation.message = text(message);
  const filename = platformRead(ERROR_EVENT_FILENAME, event);
  if (typeof filename === "string" && filename !== "") observation.filename = text(redactUrl(filename));
  const lineno = platformRead(ERROR_EVENT_LINENO, event);
  if (Number.isSafeInteger(lineno) && (lineno as number) >= 0) observation.lineno = lineno as number;
  const colno = platformRead(ERROR_EVENT_COLNO, event);
  if (Number.isSafeInteger(colno) && (colno as number) >= 0) observation.colno = colno as number;
  return observation;
}

/**
 * An unhandled rejection. The reason is read through the captured
 * `PromiseRejectionEvent` getter; another `unhandledrejection` event (one the
 * page dispatches itself) is ignored, as for `error`. Only on a runtime
 * without that class is the reason read from the event's own `reason` data
 * property, and an unreadable one is recorded as `undefined`.
 */
function readRejection(event: unknown, timestamp: number): Observation | undefined {
  const reason = attribute(REJECTION_EVENT_REASON, event, "reason");
  if (REJECTION_EVENT_REASON && reason === UNREADABLE) return undefined;
  return { source: "unhandledrejection", timestamp, ...thrown(reason === UNREADABLE ? undefined : reason) };
}

/**
 * Listens on the global, which the window events reach (a window, or a
 * worker's global scope), through the captured `EventTarget` methods. A
 * global those reject but that has its own `addEventListener` (a test
 * environment that copies a window's members onto Node's global) is
 * listened on through that method. Returns the undo, or undefined when the
 * global is no event target (plain Node) and nothing can be recorded.
 */
function listenOnGlobal(entries: Array<[string, (event: unknown) => void]>): (() => void) | undefined {
  if (entries.every(([type, listener]) => listen(globalThis, type, listener))) {
    return () => {
      for (const [type, listener] of entries) unlisten(globalThis, type, listener);
    };
  }
  for (const [type, listener] of entries) unlisten(globalThis, type, listener);
  let add: unknown;
  let remove: unknown;
  try {
    add = platform.addEventListener;
    remove = platform.removeEventListener;
  } catch {
    return undefined;
  }
  if (typeof add !== "function" || typeof remove !== "function") return undefined;
  const added: typeof entries = [];
  const undo = () => {
    for (const [type, listener] of added) {
      try {
        apply(remove as Intrinsic, globalThis, [type, listener]);
      } catch {
        /* Nothing more to undo. */
      }
    }
  };
  try {
    for (const entry of entries) {
      // Owned before the attempt: an addEventListener that registers the
      // listener and then throws still leaves it for undo() to remove.
      added.push(entry);
      apply(add, globalThis, entry);
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
  // Subscribed before installing: page code that installing runs (a replaced
  // addEventListener) and that starts another collector joins this session.
  current.add(listener);
  if (first) {
    const observe = (read: (event: unknown, timestamp: number) => Observation | undefined) => (event: unknown) => {
      if (current.size === 0) return;
      // Reading the event can run page code (an error's getters) that stops or
      // starts a collector: deliver only to collectors subscribed before it
      // ran and still subscribed after.
      const receivers = [...current];
      try {
        // A clock that gives no valid timestamp drops the observation.
        const timestamp = now();
        const observation = timestamp === undefined ? undefined : read(event, timestamp);
        if (!observation) return;
        for (const receive of receivers) {
          if (!current.has(receive)) continue;
          try {
            receive(observation);
          } catch {
            /* Capture must never change how the page reports errors. */
          }
        }
      } catch {
        /* Observation never raises into the page's event dispatch. */
      }
    };
    const onError = observe(readError);
    const onRejection = observe(readRejection);
    restore = listenOnGlobal([
      ["error", onError],
      ["unhandledrejection", onRejection],
    ]);
  }
  return () => {
    current.delete(listener);
    if (current === listeners && current.size === 0) {
      // Cleared before the cleanup runs: page code in it (a replaced
      // removeEventListener) may start a new session that owns `restore`.
      const undo = restore;
      restore = undefined;
      undo?.();
    }
  };
}

/** One start() of a collector: pending until subscribe() returns, cancelled by stop(). */
interface Subscription {
  cancelled: boolean;
  unsubscribe?: () => void;
}

/**
 * Records uncaught errors (the window `error` event) and unhandled promise
 * rejections (`unhandledrejection`) as error evidence events in a bounded
 * buffer. It only listens: it never cancels an event, so the page's own
 * handlers and the browser's console report run as before. Runs on its own,
 * without a reporter or server.
 */
export class ErrorCollector {
  private readonly events: RingBuffer<ErrorEvidenceEvent>;
  private subscription?: Subscription;

  constructor(maxSize = 50) {
    assertCapacity(maxSize);
    this.events = new RingBuffer(maxSize);
  }

  start(): void {
    // Set before subscribing: page code that installing runs and that calls
    // start() again finds it pending, a no-op.
    if (this.subscription) return;
    const subscription: Subscription = { cancelled: false };
    this.subscription = subscription;
    const unsubscribe = subscribe((observation) => {
      // A stop() during installation cancels it: nothing is recorded after that.
      if (subscription.cancelled || this.events.capacity === 0) return;
      const event: ErrorEvidenceEvent = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        kind: "error",
        seq: takeSeq(),
        timestamp: observation.timestamp,
        source: observation.source,
        message: observation.message,
      };
      // Optional fields are omitted, never present as undefined.
      for (const field of ["name", "stack", "filename", "lineno", "colno", "value"] as const) {
        if (observation[field] !== undefined) Object.assign(event, { [field]: observation[field] });
      }
      this.events.push(freezeEvent(event));
    });
    // Stopped while installing: leave the session now that its handle exists.
    if (subscription.cancelled) unsubscribe();
    else subscription.unsubscribe = unsubscribe;
  }

  stop(): void {
    const subscription = this.subscription;
    this.subscription = undefined;
    if (!subscription) return;
    subscription.cancelled = true;
    subscription.unsubscribe?.();
  }

  /** Captured events, oldest first, optionally limited to a time window. */
  collect(window?: CollectWindow): ErrorEvidenceEvent[] {
    return this.events.query(window);
  }

  clear(): void {
    this.events.clear();
  }

  size(): number {
    return this.events.size;
  }
}
