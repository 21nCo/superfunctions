/**
 * Breadcrumb collector - a bounded buffer of user actions and milestones.
 */
import {
  BREADCRUMB_LEVELS,
  BREADCRUMB_TYPES,
  EVIDENCE_SCHEMA_VERSION,
  freezeEvent,
  takeSeq,
  type BreadcrumbEvidenceEvent,
  type BreadcrumbLevel,
  type BreadcrumbType,
} from "../events.js";
import { redactUrl } from "../utils/redaction.js";
import { RingBuffer, assertCapacity, type CollectWindow } from "../utils/ring-buffer.js";
import { MAX_ENTRY_BYTES, serializeEntry, truncateToBytes, type SerializedValue } from "../utils/serialization.js";

export interface BreadcrumbInput {
  type: BreadcrumbType;
  message?: string;
  data?: Record<string, unknown>;
  category?: string;
  level?: BreadcrumbLevel;
}

function text(value: string): string {
  return truncateToBytes(String(value), MAX_ENTRY_BYTES) ?? "";
}

export class BreadcrumbCollector {
  private readonly events: RingBuffer<BreadcrumbEvidenceEvent>;

  constructor(maxSize = 50) {
    assertCapacity(maxSize);
    this.events = new RingBuffer(maxSize);
  }

  /**
   * Add a breadcrumb. Throws a TypeError for a type or level outside the v1
   * event format.
   */
  add(breadcrumb: BreadcrumbInput): void {
    if (!(BREADCRUMB_TYPES as readonly unknown[]).includes(breadcrumb.type)) {
      throw new TypeError(`breadcrumb type must be one of ${BREADCRUMB_TYPES.join(", ")}`);
    }
    if (breadcrumb.level !== undefined && !(BREADCRUMB_LEVELS as readonly unknown[]).includes(breadcrumb.level)) {
      throw new TypeError(`breadcrumb level must be one of ${BREADCRUMB_LEVELS.join(", ")}`);
    }
    if (this.events.capacity === 0) return;
    const event: BreadcrumbEvidenceEvent = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      kind: "breadcrumb",
      seq: takeSeq(),
      timestamp: Date.now(),
      type: breadcrumb.type,
    };
    if (breadcrumb.message !== undefined) event.message = text(breadcrumb.message);
    if (breadcrumb.data !== undefined) {
      const data = serializeEntry(breadcrumb.data);
      event.data = typeof data === "object" && data !== null && !Array.isArray(data) ? data : { value: data as SerializedValue };
    }
    if (breadcrumb.category !== undefined) event.category = text(breadcrumb.category);
    if (breadcrumb.level !== undefined) event.level = breadcrumb.level;
    this.events.push(freezeEvent(event));
  }

  /** Add a navigation breadcrumb. */
  addNavigation(from: string, to: string): void {
    this.add({ type: "navigation", message: `${from} → ${to}`, data: { from, to }, category: "navigation" });
  }

  /** Add a console breadcrumb. */
  addConsole(level: BreadcrumbLevel, message: string): void {
    this.add({ type: "console", message, level, category: "console" });
  }

  /** Add a network breadcrumb. The URL is redacted with `redactUrl`. */
  addNetwork(method: string, url: string, status?: number): void {
    const redacted = redactUrl(url);
    this.add({
      type: "network",
      message: `${method} ${redacted} ${status ? `(${status})` : ""}`,
      data: status === undefined ? { method, url: redacted } : { method, url: redacted, status },
      category: "network",
      level: status && status >= 400 ? "error" : "info",
    });
  }

  /** Add a user interaction breadcrumb. */
  addUser(action: string, target: string, data?: Record<string, unknown>): void {
    this.add({ type: "user", message: `${action} on ${target}`, data: { action, target, ...data }, category: "user" });
  }

  /** Captured events, oldest first, optionally limited to a time window. */
  collect(window?: CollectWindow): BreadcrumbEvidenceEvent[] {
    return this.events.query(window);
  }

  clear(): void {
    this.events.clear();
  }

  size(): number {
    return this.events.size;
  }
}
