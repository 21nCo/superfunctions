export { ConsoleCollector } from "./collectors/console.js";
export { NetworkCollector, UNREAD_METHOD, UNREAD_URL, type IgnorePattern, type NetworkCollectorOptions } from "./collectors/network.js";
export { BreadcrumbCollector, type BreadcrumbInput } from "./collectors/breadcrumbs.js";
export {
  BREADCRUMB_LEVELS,
  BREADCRUMB_TYPES,
  CONSOLE_LEVELS,
  EVIDENCE_KINDS,
  EVIDENCE_SCHEMA_VERSION,
  NETWORK_TRANSPORTS,
  evidenceEventSchema,
  isEvidenceEvent,
  validateEvidenceEvent,
  type BreadcrumbEvidenceEvent,
  type BreadcrumbLevel,
  type BreadcrumbType,
  type ConsoleEvidenceEvent,
  type ConsoleLevel,
  type EvidenceEvent,
  type EvidenceEventBase,
  type EvidenceKind,
  type NetworkEvidenceEvent,
  type NetworkTransport,
} from "./events.js";
export { RingBuffer, type CollectWindow } from "./utils/ring-buffer.js";
export { redactHeaders, redactObject, redactString, redactUrl } from "./utils/redaction.js";
export {
  CIRCULAR,
  MAX_DEPTH,
  MAX_DEPTH_MARKER,
  MAX_ENTRY_BYTES,
  MAX_KEYS,
  TRUNCATED,
  UNSERIALIZABLE,
  safeSerialize,
  serializeEntry,
  truncateString,
  type SerializedValue,
} from "./utils/serialization.js";
