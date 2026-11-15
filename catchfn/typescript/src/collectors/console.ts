import { CONSOLE_LEVELS, EVIDENCE_SCHEMA_VERSION, freezeEvent, takeSeq, type ConsoleEvidenceEvent, type ConsoleLevel } from "../events.js";
import { RingBuffer, assertCapacity, type CollectWindow } from "../utils/ring-buffer.js";
import { serializeEntry, type SerializedValue } from "../utils/serialization.js";

type ConsoleFunction = (...args: unknown[]) => void;
type Listener = (level: ConsoleLevel, args: unknown[]) => void;

// All console collectors share one set of wrappers. The first start() installs
// them and the last stop() removes them; collectors that overlap in any order
// each see only what was logged while they ran.
let listeners = new Set<Listener>();
let restore: (() => void) | undefined;

function subscribe(listener: Listener): () => void {
  if (listeners.size === 0) {
    listeners = new Set();
    const current = listeners;
    const originals = new Map<ConsoleLevel, ConsoleFunction>();
    const wrappers = new Map<ConsoleLevel, ConsoleFunction>();
    let capturing = false;
    for (const level of CONSOLE_LEVELS) {
      const original = console[level] as ConsoleFunction;
      if (typeof original !== "function") continue;
      const wrapper: ConsoleFunction = function (this: unknown, ...args: unknown[]) {
        const result = original.apply(this ?? console, args);
        // A value whose serialization logs must not recurse into capture.
        if (!capturing) {
          capturing = true;
          try {
            for (const receive of current) {
              try {
                receive(level, args);
              } catch {
                /* Capture must never break the application's logging. */
              }
            }
          } finally {
            capturing = false;
          }
        }
        return result;
      };
      originals.set(level, original);
      wrappers.set(level, wrapper);
      console[level] = wrapper;
    }
    restore = () => {
      // Put back only the functions we replaced and still own. If another
      // library wrapped ours after start(), ours stays in its chain, inert
      // because `current` is now empty.
      for (const [level, original] of originals) {
        if (console[level] === wrappers.get(level)) console[level] = original;
      }
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
 * Records `console.log/info/warn/error/debug` calls as console evidence
 * events in a bounded buffer. Runs on its own, without a reporter or server.
 */
export class ConsoleCollector {
  private readonly events: RingBuffer<ConsoleEvidenceEvent>;
  private unsubscribe?: () => void;

  constructor(maxSize = 100) {
    assertCapacity(maxSize);
    this.events = new RingBuffer(maxSize);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribe((level, args) => {
      if (this.events.capacity === 0) return;
      this.events.push(
        freezeEvent({
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          kind: "console",
          seq: takeSeq(),
          timestamp: Date.now(),
          level,
          // The argument list is one entry; each argument keeps five levels.
          args: serializeEntry(args, 0) as SerializedValue[],
        })
      );
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Captured events, oldest first, optionally limited to a time window. */
  collect(window?: CollectWindow): ConsoleEvidenceEvent[] {
    return this.events.query(window);
  }

  clear(): void {
    this.events.clear();
  }

  size(): number {
    return this.events.size;
  }
}
