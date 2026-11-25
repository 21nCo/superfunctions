import { DATAFN_ROUTE_WS_PROTOCOL, DATAFN_ROUTE_WS_TICKET_PREFIX } from "@datafn/core";
import { indexStoredRecords, recordIds } from "../searchIndexQueue.js";
import { DefaultHttpTransport } from "../transport/http.js";
/**
 * Sync Engine
 *
 * Handles background synchronization tasks:
 * - Push engine (reading changelog -> pushing to remote)
 * - Pull engine (polling/cursor-based updates)
 * - Retries and error handling
 * - Sync event emission
 * Implements HOOK-001 and EVT-003: beforeSync/afterSync hooks and sync lifecycle events
 */

import type { DatafnStorageAdapter } from "../storage.js";
import type { DatafnRemoteAdapter, DatafnSyncConfig } from "../client.js";
import type { EventBus } from "../events/bus.js";
import type { DatafnFieldSchema, DatafnSchema, DatafnPlugin, SearchProvider } from "@datafn/core";
import { enumerateJoinStoreKeys, getJoinStoreKey, getRelationKeyName } from "@datafn/core";
import {
  applyCloneResult,
  applyPullResult,
  setCursorMonotonically,
  GLOBAL_CURSOR_KEY,
  type CloneResult,
  type PullResult,
} from "./apply.js";
import { runBeforeSync, runAfterSync } from "../plugins/run-hooks.js";
import {
  buildSearchIndexFingerprint,
  clearSearchIndexCurrent,
  deriveSearchProviderResources,
  markSearchIndexCurrent,
  type DatafnSearchIndexResource,
} from "../searchIndex.js";
import {
  decryptCloneResultForE2ee,
  decryptPullResultForE2ee,
  encryptPushPayloadForE2ee,
  type DatafnE2eeConfig,
} from "../e2ee.js";
import type { DatafnSyncPhase } from "./status.js";
// CLI-008: buildEvent import removed (was unused)

const ACTOR_FEED_CURSOR_KEY = "__datafn_actor_feed__";

function isNativeBackedSearchProvider(
  searchProvider: SearchProvider | undefined,
): boolean {
  return (
    typeof searchProvider === "object" &&
    searchProvider !== null &&
    (searchProvider as { __datafnNativeBacked?: unknown }).__datafnNativeBacked === true
  );
}

/**
 * Helper: Sleep for a given number of milliseconds (PHASE_08)
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Largest delay setTimeout accepts; longer ones fire immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Sleep that also honours delays longer than one timer allows. */
async function sleepLong(ms: number): Promise<void> {
  let remaining = ms;
  do {
    const chunk = Math.min(remaining, MAX_TIMER_DELAY_MS);
    await sleep(chunk);
    remaining -= chunk;
  } while (remaining > 0);
}

/** A copy of a keyed map without the given keys (undefined stays undefined). */
function omitKeys<T>(map: Record<string, T>, keys: Set<string>): Record<string, T>;
function omitKeys<T>(map: Record<string, T> | undefined, keys: Set<string>): Record<string, T> | undefined;
function omitKeys<T>(map: Record<string, T> | undefined, keys: Set<string>) {
  if (!map || keys.size === 0) return map;
  const kept: Record<string, T> = Object.create(null);
  for (const [key, value] of Object.entries(map)) {
    if (!keys.has(key)) kept[key] = value;
  }
  return kept;
}

/** A canonical pull result without the changes and cursors of the given keys. */
function omitPullResultKeys(result: any, keys: Set<string>): any {
  if (!result || typeof result !== "object" || !result.cursors || Array.isArray(result.changes)) {
    return result;
  }
  return {
    ...result,
    records: omitKeys(result.records, keys) ?? {},
    merged: omitKeys(result.merged, keys),
    deleted: omitKeys(result.deleted, keys) ?? {},
    joins: omitKeys(result.joins, keys),
    cursors: omitKeys(result.cursors, keys),
  };
}

/**
 * Helper: Compute exponential backoff delay with jitter (PHASE_08)
 */
function computeBackoffDelay(
  attempt: number,
  config: { baseDelayMs: number; multiplier: number; maxDelayMs: number; jitterMs: number }
): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(config.multiplier, attempt);
  const jitter = Math.random() * config.jitterMs;
  return Math.min(exponentialDelay + jitter, config.maxDelayMs);
}

type RecordMutationOperation = "insert" | "merge" | "replace";

type PushMutationError = {
  mutationId?: string;
  code?: string;
  message?: string;
  path?: string;
  retryable?: boolean;
};

type PushSyncResult = {
  ok: boolean;
  applied?: string[];
  errors?: PushMutationError[];
  cursor?: string;
  cursorBefore?: string;
  cursors?: Record<string, string>;
};

function isRecordMutationOperation(operation: unknown): operation is RecordMutationOperation {
  return operation === "insert" || operation === "merge" || operation === "replace";
}

function cloneDefaultValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneDefaultValue(item));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneDefaultValue(child)]),
    );
  }

  return value;
}

function resolveFieldDefault(field: DatafnFieldSchema): { hasDefault: boolean; value?: unknown } {
  if (Object.prototype.hasOwnProperty.call(field, "default")) {
    return { hasDefault: true, value: cloneDefaultValue(field.default) };
  }

  if (field.required && field.type === "array") {
    return { hasDefault: true, value: [] };
  }

  return { hasDefault: false };
}

function buildWritableRecordFieldsByResource(
  schema: DatafnSchema,
): Map<string, Set<string>> {
  const fieldsByResource = new Map<string, Set<string>>();

  for (const resource of schema.resources) {
    const fields = new Set<string>(["id"]);
    for (const field of resource.fields) {
      if (!field.readonly) fields.add(field.name);
    }
    fieldsByResource.set(resource.name, fields);
  }

  for (const relation of schema.relations ?? []) {
    const fromResources = Array.isArray(relation.from)
      ? relation.from
      : [relation.from];
    for (const fromResource of fromResources) {
      const fields = fieldsByResource.get(fromResource);
      if (!fields) continue;
      const fkField = relation.fkField || relation.foreignKey;
      if (typeof fkField === "string" && fkField.length > 0) {
        fields.add(fkField);
      }
      if (
        relation.type === "htree" &&
        typeof relation.pathField === "string" &&
        relation.pathField.length > 0
      ) {
        fields.add(relation.pathField);
      }
    }
  }

  return fieldsByResource;
}

function buildWritableRecordDefaultsByResource(
  schema: DatafnSchema,
): Map<string, Map<string, unknown>> {
  const defaultsByResource = new Map<string, Map<string, unknown>>();

  for (const resource of schema.resources) {
    const defaults = new Map<string, unknown>();
    for (const field of resource.fields) {
      if (field.readonly) continue;
      const fieldDefault = resolveFieldDefault(field);
      if (fieldDefault.hasDefault) defaults.set(field.name, fieldDefault.value);
    }
    if (defaults.size > 0) defaultsByResource.set(resource.name, defaults);
  }

  return defaultsByResource;
}

function buildWritableRelationMetadataByResource(
  schema: DatafnSchema,
): Map<string, Map<string, Set<string>>> {
  const relationMetadataByResource = new Map<string, Map<string, Set<string>>>();

  for (const relation of schema.relations ?? []) {
    if (!relation.relation) continue;
    const fromResources = Array.isArray(relation.from)
      ? relation.from
      : [relation.from];
    for (const fromResource of fromResources) {
      const relationMap =
        relationMetadataByResource.get(fromResource) ?? new Map<string, Set<string>>();
      relationMap.set(
        relation.relation,
        new Set(relation.metadata?.map((item) => item.name) ?? []),
      );
      relationMetadataByResource.set(fromResource, relationMap);
    }
  }

  return relationMetadataByResource;
}

function sanitizeRelationPayloadMetadata(
  value: unknown,
  allowedMetadata: Set<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRelationPayloadMetadata(item, allowedMetadata));
  }

  if (typeof value !== "object" || value === null) return value;
  const item = value as Record<string, unknown>;
  if (typeof item.$ref !== "string") return value;
  return Object.fromEntries(
    Object.entries(item).filter(
      ([key]) => key === "$ref" || allowedMetadata.has(key),
    ),
  );
}

function sanitizeChangelogMutationForSchema(
  fieldsByResource: Map<string, Set<string>>,
  defaultsByResource: Map<string, Map<string, unknown>>,
  relationMetadataByResource: Map<string, Map<string, Set<string>>>,
  mutation: unknown,
): unknown {
  if (typeof mutation !== "object" || mutation === null || Array.isArray(mutation)) {
    return mutation;
  }

  const entry = mutation as Record<string, unknown>;
  if (typeof entry.resource !== "string") return mutation;
  let changed = false;
  let nextEntry = entry;

  if (
    isRecordMutationOperation(entry.operation) &&
    typeof entry.record === "object" &&
    entry.record !== null &&
    !Array.isArray(entry.record)
  ) {
    const fields = fieldsByResource.get(entry.resource);
    if (fields) {
      const record = entry.record as Record<string, unknown>;
      const nextRecord: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(record)) {
        if (fields.has(key)) {
          nextRecord[key] = value;
        } else {
          changed = true;
        }
      }

      if (entry.operation === "insert" || entry.operation === "replace") {
        const defaults = defaultsByResource.get(entry.resource);
        if (defaults) {
          for (const [key, value] of defaults) {
            if (!(key in nextRecord)) {
              nextRecord[key] = cloneDefaultValue(value);
              changed = true;
            }
          }
        }
      }

      if (changed) {
        nextEntry = {
          ...nextEntry,
          record: nextRecord,
        };
      }
    }
  }

  if (
    typeof entry.relations === "object" &&
    entry.relations !== null &&
    !Array.isArray(entry.relations)
  ) {
    const relationMetadata = relationMetadataByResource.get(entry.resource);
    if (relationMetadata) {
      const relations = entry.relations as Record<string, unknown>;
      const nextRelations: Record<string, unknown> = {};
      for (const [relationName, value] of Object.entries(relations)) {
        const allowedMetadata = relationMetadata.get(relationName);
        if (!allowedMetadata) {
          nextRelations[relationName] = value;
          continue;
        }
        const nextValue = sanitizeRelationPayloadMetadata(value, allowedMetadata);
        nextRelations[relationName] = nextValue;
        if (nextValue !== value) changed = true;
      }
      if (changed) {
        nextEntry = {
          ...nextEntry,
          relations: nextRelations,
        };
      }
    }
  }

  return changed ? nextEntry : mutation;
}

function getChangelogMutationId(entry: {
  mutationId?: string;
  mutation?: Record<string, unknown>;
}): string | undefined {
  const mutationId =
    typeof entry.mutation?.mutationId === "string"
      ? entry.mutation.mutationId
      : entry.mutationId;
  return typeof mutationId === "string" ? mutationId : undefined;
}

function computeAckThroughSeq(
  entries: Array<{
    seq: number;
    mutationId?: string;
    mutation?: Record<string, unknown>;
  }>,
  result: PushSyncResult | readonly PushSyncResult[],
  omittedMutationIds: ReadonlySet<string> = new Set(),
): number | null {
  const results = Array.isArray(result) ? result : [result];
  const applied = new Set<string>();
  const errorsByMutationId = new Map<string, PushMutationError>();
  for (const currentResult of results) {
    for (const mutationId of currentResult.applied ?? []) {
      applied.add(mutationId);
      errorsByMutationId.delete(mutationId);
    }
    for (const error of currentResult.errors ?? []) {
      if (typeof error.mutationId === "string" && !applied.has(error.mutationId)) {
        errorsByMutationId.set(error.mutationId, error);
      }
    }
  }

  let throughSeq: number | null = null;
  for (const entry of entries) {
    const mutationId = getChangelogMutationId(entry);
    if (!mutationId) break;
    if (applied.has(mutationId) || omittedMutationIds.has(mutationId)) {
      throughSeq = entry.seq;
      continue;
    }
    const error = errorsByMutationId.get(mutationId);
    if (error?.retryable === false) {
      throughSeq = entry.seq;
      continue;
    }
    break;
  }
  return throughSeq;
}

function hasTerminalMutationError(result: PushSyncResult): boolean {
  return (result.errors ?? []).some((error) => error.retryable === false);
}

export class SyncEngine {
  private inFlight = false;
  private pullInFlight = false;
  /**
   * Tables a clone pass is writing (with the number of passes writing each).
   * Pulls leave these tables, and the join stores that touch them, to the
   * clone: a pull applied between two clone batches could otherwise advance
   * the table's cursor past a change that a later batch overwrites.
   */
  private cloningTables = new Map<string, number>();
  /** A pull skipped cloning tables; pull again once no clone is running. */
  private pullAfterClone = false;
  /** Clone passes started per table, so a pull can tell one began and ended meanwhile. */
  private cloneStarts = new Map<string, number>();
  /**
   * The storage writes of the pull result being applied now, if any. A clone
   * waits for them before it starts, so a pull that did not leave a table to
   * it cannot write its older rows over the cloned ones.
   */
  private pullApplying: Promise<void> | null = null;
  private pullAfterReconnect = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pushBatchSize = 100;
  private pushMaxRetries = 3;
  private pushInterval: number | undefined;
  private boundOnVisibilityChange: () => void;
  private boundOnWindowFocus: () => void;
  private boundOnOnline: () => void;
  private boundOnOffline: () => void;
  private isOnline = typeof navigator !== "undefined" ? (navigator.onLine ?? true) : true;
  private pushPausedForOffline = false;
  private ws: WebSocket | null = null;
  private wsUrl: string | undefined;
  private wsGeneration = 0;
  private started = false;
  /** Advanced by every start() and stop(); identifies the start that owns `started`. */
  private startSession = 0;
  private wsRouteUnsubscribe?: () => void;
  private wsExpiryTimer?: ReturnType<typeof setTimeout>;
  private hydrationPlan?: {
    bootResources?: string[];
    backgroundResources?: string[];
    clonePageSize?: number | Record<string, number>;
  };
  private plugins: DatafnPlugin[] = [];
  private getTimestamp: () => number;
  private searchProvider?: SearchProvider;
  private wsReconnectAttempt = 0;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsReconnectEnabled = true;
  private config?: DatafnSyncConfig;
  private pushConsecutiveFailures = 0;
  private pushIntervalBackoffActive = false;
  private pushRerunRequested = false;
  private writableRecordFieldsByResource: Map<string, Set<string>>;
  private writableRecordDefaultsByResource: Map<string, Map<string, unknown>>;
  private writableRelationMetadataByResource: Map<string, Map<string, Set<string>>>;
  private searchIndexVersion?: string;
  private searchProviderResourceByName: Map<string, DatafnSearchIndexResource>;

  constructor(
    private storage: DatafnStorageAdapter,
    private remote: DatafnRemoteAdapter,
    private eventBus: EventBus,
    private clientId: string,
    private schema: DatafnSchema,
    config?: DatafnSyncConfig,
    plugins?: DatafnPlugin[],
    getTimestamp?: () => number,
    searchProvider?: SearchProvider,
    searchIndexVersion?: string,
    private e2ee?: DatafnE2eeConfig,
  ) {
    this.config = config;
    this.pushBatchSize = config?.pushBatchSize ?? 100;
    this.pushMaxRetries = config?.pushMaxRetries ?? 3;
    this.pushInterval = config?.pushInterval;
    this.boundOnVisibilityChange = this.onVisibilityChange.bind(this);
    this.boundOnWindowFocus = this.onWindowFocus.bind(this);
    this.boundOnOnline = this.onOnline.bind(this);
    this.boundOnOffline = this.onOffline.bind(this);
    this.hydrationPlan = config?.hydration;
    this.plugins = plugins || [];
    this.getTimestamp = getTimestamp || (() => Date.now());
    this.searchProvider = searchProvider;
    this.searchIndexVersion = searchIndexVersion;
    this.writableRecordFieldsByResource =
      buildWritableRecordFieldsByResource(schema);
    this.writableRecordDefaultsByResource =
      buildWritableRecordDefaultsByResource(schema);
    this.writableRelationMetadataByResource =
      buildWritableRelationMetadataByResource(schema);
    this.searchProviderResourceByName = new Map(
      deriveSearchProviderResources(schema).map((resource) => [
        resource.name,
        resource,
      ]),
    );

    if (config?.ws && config.wsUrl) {
      this.wsUrl = config.wsUrl;
    } else if (config?.ws && config?.remote) {
      const remote = config.remote;
      const wsProtocol = remote.startsWith("https") ? "wss" : "ws";
      // Replace protocol (handles http/https)
      const base = remote.replace(/^http(s)?:\/\//, "");
      this.wsUrl = `${wsProtocol}://${base}/ws`;
    }
  }

  /**
   * Start the sync loop (if interval is configured)
   */
  async start() {
    // REL-005: Guard against duplicate push timers — if start() is called twice, skip
    if (this.started) return;
    this.started = true;
    this.wsReconnectEnabled = true;
    const generation = this.wsGeneration;
    const session = ++this.startSession;

    // 1. Initial sync
    try { await this.initializeSync(); }
    catch (error) {
      // Only the start that still owns `started` may clear it: a start that
      // stop() superseded must not reset a newer start's state.
      if (session === this.startSession) this.started = false;
      throw error;
    }
    if (!this.started || generation !== this.wsGeneration) return;

    // 2. Start push loop
    if (this.pushInterval) {
      this.timer = setInterval(() => this.processPush(), this.pushInterval);
    }

    // 3. Register visibility listener, focus listener, and online/offline listeners
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener(
        "visibilitychange",
        this.boundOnVisibilityChange,
      );
    }
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("focus", this.boundOnWindowFocus);
      // Read current connectivity state
      this.isOnline = typeof navigator !== "undefined" ? (navigator.onLine ?? true) : true;
      window.addEventListener("online", this.boundOnOnline);
      window.addEventListener("offline", this.boundOnOffline);
    }

    // 4. Connect WebSocket
    if (this.wsUrl || (this.config?.ws && this.config.routeProvider)) {
      void this.connectWs();
    }
  }

  /**
   * Stop the sync loop
   */
  stop() {
    // Disable reconnection
    this.wsReconnectEnabled = false;
    this.started = false;
    // Supersede any start() still running its initial sync.
    this.startSession++;
    this.pullAfterReconnect = false;
    this.wsGeneration++;
    this.wsRouteUnsubscribe?.();
    this.wsRouteUnsubscribe = undefined;
    clearTimeout(this.wsExpiryTimer);
    
    // Clear reconnection timer
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (typeof document !== "undefined" && document.removeEventListener) {
      document.removeEventListener(
        "visibilitychange",
        this.boundOnVisibilityChange,
      );
    }
    if (typeof window !== "undefined" && window.removeEventListener) {
      window.removeEventListener("focus", this.boundOnWindowFocus);
      window.removeEventListener("online", this.boundOnOnline);
      window.removeEventListener("offline", this.boundOnOffline);
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Connect WebSocket for real-time updates
   */
  private async connectWs() {
    const routes = this.remote instanceof DefaultHttpTransport ? this.remote.regionalRoutes : undefined;
    if (typeof WebSocket === "undefined" || (!this.wsUrl && !routes) || !this.wsReconnectEnabled) return;
    const generation = ++this.wsGeneration;

    try {
      const route = await routes?.get();
      if (!this.wsReconnectEnabled || generation !== this.wsGeneration) return;
      const url = route?.wsUrl ?? (route ? undefined : this.wsUrl);
      // An HTTP-only descriptor does not advertise a socket service. Keep HTTP sync active.
      if (!url) {
        // Wake on descriptor changes without polling an HTTP-only route.
        this.wsRouteUnsubscribe?.();
        this.wsRouteUnsubscribe = routes?.subscribe(() => {
          this.wsRouteUnsubscribe?.();
          this.wsRouteUnsubscribe = undefined;
          if (this.wsReconnectEnabled && this.config?.wsReconnect?.enabled !== false && generation === this.wsGeneration) void this.connectWs();
        });
        return;
      }
      const authProtocols = [...await this.config?.wsProtocols?.() ?? []];
      if (!this.wsReconnectEnabled || generation !== this.wsGeneration) return;
      // Credentials may take longer than a renewal or migration. Never pin the old grant.
      if (routes && await routes.get() !== route) {
        if (this.wsReconnectEnabled && generation === this.wsGeneration) void this.connectWs();
        return;
      }
      if (!this.wsReconnectEnabled || generation !== this.wsGeneration) return;
      const socket = route
        ? new WebSocket(url, [DATAFN_ROUTE_WS_PROTOCOL, `${DATAFN_ROUTE_WS_TICKET_PREFIX}${route.ticket}`, ...authProtocols])
        : new WebSocket(url, authProtocols);
      const reconnectAttempt = this.wsReconnectAttempt;
      this.ws = socket;
      if (route) {
        this.wsExpiryTimer = setTimeout(() => socket.close(4511, "DATAFN_ROUTE_TICKET_EXPIRED"), Math.max(0, route.expiresAt - Date.now()));
        this.wsRouteUnsubscribe = routes!.subscribe(() => {
          // HTTP renewal/invalidation also refreshes the pinned socket. Close handler re-bootstraps.
          socket.close(1000, "Regional route changed");
        });
      }

      this.ws.onopen = async () => {
        // Reset reconnection attempt counter on successful connection
        this.wsReconnectAttempt = 0;

        let cursors: Awaited<ReturnType<SyncEngine["buildPullCursors"]>>;
        try { cursors = await this.buildPullCursors(); }
        catch { socket.close(1011, "Sync checkpoint unavailable"); return; }
        if (this.ws !== socket || socket.readyState !== 1) return;
        
        // Send hello with current cursors
        socket.send(
          JSON.stringify({
            type: "hello",
            clientId: this.clientId,
            cursors,
          }),
        );
        
        // Hello is not a catch-up protocol: recover writes missed before this socket opened.
        // If an earlier pull is still running, queue a fresh checkpoint-based pull behind it.
        void this.pullNow(true);

        // Emit ws_connected event
        this.eventBus.emit({
          type: "ws_connected",
          timestampMs: this.getTimestamp(),
        });
      };

      this.ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "cursor" && msg.cursor) {
            const stored =
              (await this.storage.getCursor(GLOBAL_CURSOR_KEY)) || "0";
            const serverSeq = parseInt(msg.cursor, 10);
            const storedSeq = parseInt(stored, 10);

          if (serverSeq > storedSeq) {
              // REL-015: use .catch() to prevent unhandled promise rejection in WS message handler
              this.pullNow().catch((err) =>
                console.warn("[datafn] pullNow error in WS message handler:", err)
              );
            }
          }
        } catch (e) {
          // Ignore invalid messages
        }
      };

      this.ws.onerror = (e) => {
        if (route) console.error("Regional WebSocket connection failed");
        else console.error("WebSocket error:", e);
      };

      this.ws.onclose = (event) => {
        if (this.ws !== socket) return;
        this.wsRouteUnsubscribe?.();
        this.wsRouteUnsubscribe = undefined;
        clearTimeout(this.wsExpiryTimer);
        if ([4401, 4403, 4510, 4511].includes(event.code)) routes?.invalidate(route);
        this.ws = null;
        // An upgrade may open before admission rejects it. Preserve the attempt count
        // across throttled admissions instead of resetting backoff on every open event.
        if (event?.code === 4503 || event?.code === 1013) {
          this.wsReconnectAttempt = Math.max(this.wsReconnectAttempt, reconnectAttempt);
        }
        if (route && (event.code === 4403 || event.code === 4401)) this.wsReconnectEnabled = false;
        
        // Emit ws_disconnected event
        this.eventBus.emit({
          type: "ws_disconnected",
          timestampMs: this.getTimestamp(),
        });
        
        // Schedule reconnection if enabled
        if (this.wsReconnectEnabled && this.config?.wsReconnect?.enabled !== false) {
          this.scheduleReconnect();
        }
      };
    } catch (e) {
      if (this.wsReconnectEnabled && this.config?.wsReconnect?.enabled !== false) this.scheduleReconnect();
    }
  }

  /**
   * Schedule WebSocket reconnection with exponential backoff and jitter
   */
  private scheduleReconnect() {
    const { 
      baseDelayMs = 1000, 
      multiplier = 2, 
      maxDelayMs = 60000, 
      jitterMs = 500 
    } = this.config?.wsReconnect ?? {};
    
    // Calculate delay with exponential backoff: baseDelayMs * multiplier^attempt
    const exponentialDelay = baseDelayMs * Math.pow(multiplier, this.wsReconnectAttempt);
    
    // Add random jitter to prevent thundering herd
    const jitter = Math.random() * jitterMs;
    
    // Cap at maxDelayMs
    const delay = Math.min(exponentialDelay + jitter, maxDelayMs);
    
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectAttempt++;
      this.connectWs();
    }, delay);
  }

  /**
   * Visibility change handler (TV-PULL-002)
   */
  private onVisibilityChange() {
    if (document.visibilityState === "visible") {
      this.pullNow();
    }
  }

  /**
   * Window focus handler — triggers pull when user returns to the app window.
   * Mirrors the Nucleus `onAppear` pattern (`<svelte:window on:focus={onAppear} />`).
   * pullNow() has an in-flight guard so rapid focus events won't cause duplicate pulls.
   */
  private onWindowFocus() {
    this.pullNow();
  }

  /**
   * Online handler — emits connectivity_changed, resumes push loop, triggers immediate sync.
   */
  private onOnline() {
    this.isOnline = true;
    this.eventBus.emit({
      type: "connectivity_changed",
      timestampMs: this.getTimestamp(),
      context: { isOnline: true },
    });

    // Resume push interval if it was paused for offline
    if (this.pushPausedForOffline && this.pushInterval) {
      this.pushPausedForOffline = false;
      this.timer = setInterval(() => this.processPush(), this.pushInterval);
    }

    // Trigger immediate sync
    this.pullNow();
    setTimeout(() => this.processPush(), 0);
  }

  /**
   * Offline handler — emits connectivity_changed and pauses the push interval.
   */
  private onOffline() {
    this.isOnline = false;
    this.eventBus.emit({
      type: "connectivity_changed",
      timestampMs: this.getTimestamp(),
      context: { isOnline: false },
    });

    // Pause the regular push interval to save battery (skip backoff timer — it will expire on its own)
    if (this.timer && this.pushInterval && !this.pushIntervalBackoffActive) {
      clearInterval(this.timer);
      this.timer = null;
      this.pushPausedForOffline = true;
    }
  }

  private async buildPullCursors(): Promise<Record<string, string>> {
    const cursors: Record<string, string> = Object.create(null);

    for (const res of this.schema.resources) {
      if (res.isRemoteOnly) continue;
      const cursor = await this.storage.getCursor(res.name) || "0";
      cursors[res.name] = cursor;
    }

    if (this.schema.relations) {
      for (const joinStoreKey of enumerateJoinStoreKeys(this.schema.relations)) {
        cursors[joinStoreKey] = await this.storage.getCursor(joinStoreKey) || "0";
      }
    }

    cursors[ACTOR_FEED_CURSOR_KEY] =
      await this.storage.getCursor(ACTOR_FEED_CURSOR_KEY) || "0";

    return cursors;
  }

  /**
   * Initialize sync: Clone if fresh, Pull if hydrated (SYNC-PULL-001)
   * Supports hydration plan: clone bootResources first, then backgroundResources (SYNC-002)
   */
  async initializeSync() {
    // If hydration plan is provided, use it
    if (this.hydrationPlan?.bootResources || this.hydrationPlan?.backgroundResources) {
      await this.initializeWithHydrationPlan();
      return;
    }

    // Default behavior: check if all tables need clone
    let needsClone = false;

    for (const res of this.schema.resources) {
      if (res.isRemoteOnly) continue;
      const state = await this.storage.getHydrationState(res.name);
      if (state !== "ready") {
        needsClone = true;
        break;
      }
    }

    if (needsClone) {
      await this.cloneNow();
    } else {
      await this.pullNow();
    }
  }

  /**
   * Initialize with hydration plan (SYNC-002)
   * Only clones resources that are not yet in "ready" state; pulls for the rest.
   */
  private async initializeWithHydrationPlan() {
    const { bootResources = [], backgroundResources = [] } = this.hydrationPlan!;

    // Auto-include schema resources not listed in any plan bucket and not remote-only.
    // Framework-injected resources (e.g. "kv") are never added to user hydration plans,
    // so they would otherwise stay at "notStarted" forever, causing every query to fall
    // back to the remote server (RC-1 / issue 2026-03-02-k7m4x9r8).
    const plannedResources = new Set([...bootResources, ...backgroundResources]);
    const unplannedResources = this.schema.resources
      .filter((r) => !r.isRemoteOnly && !plannedResources.has(r.name))
      .map((r) => r.name);

    // Merge unplanned resources into boot (they are typically small — kv is tiny)
    const effectiveBootResources = [...bootResources, ...unplannedResources];

    // Partition boot resources into those needing clone vs already ready
    const bootNeedingClone: string[] = [];
    for (const table of effectiveBootResources) {
      const state = await this.storage.getHydrationState(table);
      if (state !== "ready") {
        bootNeedingClone.push(table);
      }
    }

    if (bootNeedingClone.length > 0) {
      await this.cloneResources(bootNeedingClone);
    }

    // If all boot resources were already ready, do a pull to catch up on missed changes
    if (bootNeedingClone.length === 0 && effectiveBootResources.length > 0) {
      await this.pullNow();
    }

    // Partition background resources the same way
    const bgNeedingClone: string[] = [];
    for (const table of backgroundResources) {
      const state = await this.storage.getHydrationState(table);
      if (state !== "ready") {
        bgNeedingClone.push(table);
      }
    }

    if (bgNeedingClone.length > 0) {
      this.cloneResourcesInBackground(bgNeedingClone);
    }
  }

  /**
   * Clone specific resources and wait for completion
   * Implements HOOK-001 and EVT-003
   */
  private async cloneResources(tables: string[]) {
    for (const table of tables) {
      this.cloningTables.set(table, (this.cloningTables.get(table) ?? 0) + 1);
      this.cloneStarts.set(table, (this.cloneStarts.get(table) ?? 0) + 1);
    }
    try {
      while (this.pullApplying) await this.pullApplying;
      await this.runCloneResources(tables);
    } finally {
      for (const table of tables) {
        const passes = (this.cloningTables.get(table) ?? 1) - 1;
        if (passes > 0) this.cloningTables.set(table, passes);
        else this.cloningTables.delete(table);
      }
      // Changes a pull left to the clone are replayed from the cursor the
      // clone stored.
      if (this.cloningTables.size === 0 && this.pullAfterClone) {
        this.pullAfterClone = false;
        void this.pullNow(true);
      }
    }
  }

  /**
   * Sync keys (tables and join stores) that pulls leave to a clone: the
   * given tables (by default those a clone is writing now) and the join
   * stores that touch them, keyed as buildPullCursors keys them.
   */
  private cloningSyncKeys(tables: ReadonlySet<string> = new Set(this.cloningTables.keys())): Set<string> {
    const keys = new Set<string>(tables);
    if (keys.size === 0) return keys;
    for (const relation of this.schema.relations ?? []) {
      if (relation.type !== "many-many") continue;
      const froms = Array.isArray(relation.from) ? relation.from : [relation.from];
      const tos = Array.isArray(relation.to) ? relation.to : [relation.to];
      for (const from of froms as string[]) {
        for (const to of tos as string[]) {
          if (tables.has(from) || tables.has(to)) {
            keys.add(getJoinStoreKey(from, getRelationKeyName(relation, to), to));
          }
        }
      }
    }
    return keys;
  }

  private async runCloneResources(tables: string[]) {
    try {
      const sortedResources = [...tables].sort((left, right) => left.localeCompare(right));
      this.emitSyncStarted("clone", { resources: sortedResources });

      // Mark tables as hydrating
      for (const table of tables) {
        await this.storage.setHydrationState(table, "hydrating");
      }

      // Prepare payload for hooks
      const payload = {
        clientId: this.clientId,
        tables,
        includeJoins: true,
      };

      // Run beforeSync hooks (fail-closed) (HOOK-001)
      const transformedPayload = await runBeforeSync(
        this.plugins,
        this.schema,
        "clone",
        payload,
      );

      // Clone with pagination if configured
      const pageSize = this.getClonePageSize(tables[0]); // Use first table for now
      const skipCloneIndexing = this.config?.skipCloneIndexing === true;
      const searchProvider = this.searchProvider;
      const shouldManageSearchIndices =
        !!searchProvider && !isNativeBackedSearchProvider(searchProvider);
      const failedSearchIndexResources = new Set<string>();
      const usesPaginatedClone = !!pageSize && pageSize < 1000;
      let result: CloneResult;
      
      if (usesPaginatedClone) {
        // Use pagination
        for (const table of tables) {
          await this.cloneTablePaginated(table, pageSize, !skipCloneIndexing);
        }
        result = { ok: true, data: {}, cursors: {}, next: {} };
      } else {
        // Clone all at once
        const response: any = await this.cloneWithRateLimitRetry(transformedPayload);

        if (response.ok && response.result?.ok) {
          result = await decryptCloneResultForE2ee(
            this.schema,
            this.e2ee,
            response.result as CloneResult,
          );
          // When the server capped the response (SCA-002 auto-pagination), a
          // table with a next marker is incomplete: it stays "hydrating" and
          // is continued page by page below.
          const continuations = (result as { paginated?: boolean }).paginated
            ? Object.entries(result.next ?? {}).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              )
            : [];
          await applyCloneResult(this.storage, result, {
            markReady: continuations.length === 0,
            // A clone may restart a table an earlier pass left incomplete;
            // keep that pass's older cursor so a pull replays its gap.
            keepEarliestCursor: true,
          });
          if (shouldManageSearchIndices) {
            if (!skipCloneIndexing) {
              for (const [resource, records] of Object.entries(result.data)) {
                if (records.length > 0) {
                  try {
                    await indexStoredRecords(searchProvider, this.storage, resource, recordIds(records));
                  } catch {
                    failedSearchIndexResources.add(resource);
                    await this.clearSearchIndexComplete(resource);
                    // fail-soft
                  }
                }
              }
            }
          }
          for (const [table, afterId] of continuations) {
            const indexed = await this.cloneTablePaginated(
              table,
              pageSize,
              !skipCloneIndexing,
              afterId === "" ? null : afterId,
              // A failure indexing the first batch keeps the index incomplete.
              !failedSearchIndexResources.has(table),
            );
            if (!indexed) failedSearchIndexResources.add(table);
          }
        } else {
          throw new Error(response.error?.message || "Clone rejected by server");
        }
      }

      // Ensure every requested table reaches "ready" even if the server returned no
      // records for it (RC-4 / issue 2026-03-02-k7m4x9r8).  applyCloneResult only
      // marks a resource "ready" when it appears in the response data object, so a
      // resource with zero records would be left stuck at "hydrating".
      for (const table of tables) {
        const state = await this.storage.getHydrationState(table);
        if (state !== "ready") {
          await this.storage.setHydrationState(table, "ready");
        }
      }

      if (shouldManageSearchIndices && !skipCloneIndexing && !usesPaginatedClone) {
        for (const table of tables) {
          if (!failedSearchIndexResources.has(table)) {
            await this.markSearchIndexComplete(table);
          }
        }
      }

      // Run afterSync hooks (fail-open) (HOOK-001)
      await runAfterSync(
        this.plugins,
        this.schema,
        "clone",
        transformedPayload,
        result,
      );

      // Emit sync_applied event (EVT-003)
      this.eventBus.emit({
        type: "sync_applied",
        timestampMs: this.getTimestamp(),
        context: {
          phase: "clone",
          resources: tables.sort(), // Stable sort for determinism
          cursors: result.cursors || {},
        },
      });
    } catch (err: any) {
      this.eventBus.emit({
        type: "sync_failed",
        timestampMs: this.getTimestamp(),
        context: {
          phase: "clone",
          error: {
            code: err.code || "INTERNAL",
            message: err.message || "Clone failed",
          },
        },
      });
      throw err;
    }
  }

  /**
   * Clone resources in the background (non-blocking)
   */
  private cloneResourcesInBackground(tables: string[]) {
    // REL-006: Schedule async clone with error handling
    setTimeout(async () => {
      try {
        await this.cloneResources(tables);
      } catch (error: any) {
        this.eventBus.emit({
          type: "sync_failed",
          timestampMs: this.getTimestamp(),
          context: {
            phase: "clone",
            operation: "background",
            error: {
              code: error.code || "INTERNAL",
              message: error.message || "Background clone failed",
            },
            tables,
          },
        });
        // Mark tables as failed, not stuck in hydrating
        for (const table of tables) {
          try {
            await this.storage.setHydrationState(table, "notStarted");
          } catch {
            // Best-effort state update
          }
        }
      }
    }, 0);
  }

  /**
   * Send a clone request, waiting and retrying while the server answers that
   * the client is rate limited. Honours the server's Retry-After (surfaced by
   * the HTTP transport as `error.details.retryAfterMs`) in full, otherwise
   * backs off exponentially. Returns the last response once retries are exhausted.
   */
  private async cloneWithRateLimitRetry(payload: unknown): Promise<any> {
    const policy = this.config?.cloneRateLimitRetry;
    const configuredRetries = policy?.maxRetries;
    const maxRetries =
      typeof configuredRetries === "number" && Number.isFinite(configuredRetries)
        ? Math.max(0, Math.floor(configuredRetries))
        : 6;
    // A missing, negative or non-finite setting takes its default, so the
    // computed delay is always finite (an infinite one would never fire).
    const setting = (value: unknown, fallback: number): number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
    const backoff = {
      baseDelayMs: setting(policy?.baseDelayMs, 1000),
      multiplier: setting(policy?.multiplier, 2),
      maxDelayMs: setting(policy?.maxDelayMs, 60000),
      jitterMs: setting(policy?.jitterMs, 500),
    };
    for (let attempt = 0; ; attempt++) {
      const response: any = await this.remote.clone(payload);
      const code = response?.error?.code ?? response?.result?.error?.code;
      const rateLimited = code === "RATE_LIMITED" || code === "DATAFN_ROUTE_RATE_LIMITED";
      if (!rateLimited || attempt >= maxRetries) {
        return response;
      }
      const retryAfterMs = Number(
        response?.error?.details?.retryAfterMs ?? response?.result?.error?.details?.retryAfterMs,
      );
      // The server's Retry-After is honoured in full; maxDelayMs caps only
      // the computed backoff.
      const delayMs =
        Number.isFinite(retryAfterMs) && retryAfterMs >= 0
          ? retryAfterMs
          : computeBackoffDelay(attempt, backoff);
      await sleepLong(delayMs);
    }
  }

  /**
   * Clone a single table with pagination
   */
  private async cloneTablePaginated(
    table: string,
    pageSize: number,
    indexAfterPage: boolean,
    startAfterId: string | null = null,
    initialSearchIndexComplete = true,
  ): Promise<boolean> {
    let afterId: string | null = startAfterId;
    let hasMore = true;
    let searchIndexComplete = initialSearchIndexComplete;

    while (hasMore) {
      const response: any = await this.cloneWithRateLimitRetry({
        clientId: this.clientId,
        tables: [table],
        page: {
          table,
          afterId,
          limit: pageSize,
        },
        includeJoins: true,
      });

      if (response.ok && response.result?.ok) {
        const cloneResult = await decryptCloneResultForE2ee(
          this.schema,
          this.e2ee,
          response.result as CloneResult,
        );
        // A page never marks the table ready: until the last page lands the
        // table is incomplete, and an interrupted clone must start it again.
        // Pages are read at different server sequences and a pass may resume
        // an interrupted one, so the stored cursor stays at the earliest.
        await applyCloneResult(this.storage, cloneResult, {
          markReady: false,
          keepEarliestCursor: true,
        });
        if (indexAfterPage && this.searchProvider && !isNativeBackedSearchProvider(this.searchProvider)) {
          const records = cloneResult.data?.[table] ?? [];
          if (records.length > 0) {
            try {
              await indexStoredRecords(this.searchProvider, this.storage, table, recordIds(records));
            } catch {
              searchIndexComplete = false;
              await this.clearSearchIndexComplete(table);
              // fail-soft
            }
          }
        }
        
        // Check if there are more pages
        const nextMarker = response.result.next?.[table];
        if (nextMarker === null || nextMarker === undefined) {
          hasMore = false;
        } else {
          afterId = nextMarker;
        }
      } else {
        throw new Error(response.error?.message || "Clone rejected by server");
      }
    }

    // Every page has been applied: the table is complete.
    await this.storage.setHydrationState(table, "ready");

    if (
      indexAfterPage &&
      this.searchProvider &&
      !isNativeBackedSearchProvider(this.searchProvider) &&
      searchIndexComplete
    ) {
      await this.markSearchIndexComplete(table);
    }
    return searchIndexComplete;
  }

  /**
   * Get clone page size for a specific table
   */
  private getClonePageSize(table: string): number {
    const config = this.hydrationPlan?.clonePageSize;
    
    if (typeof config === "number") {
      return config;
    }
    
    if (typeof config === "object" && config[table]) {
      return config[table];
    }
    
    return 1000; // Default
  }

  private getSearchIndexFingerprint(resource: string): string | undefined {
    const resourceConfig = this.searchProviderResourceByName.get(resource);
    if (!resourceConfig) {
      return undefined;
    }
    return buildSearchIndexFingerprint({
      providerName: this.searchProvider?.name,
      resource: resourceConfig,
      version: this.searchIndexVersion,
    });
  }

  private async markSearchIndexComplete(resource: string): Promise<void> {
    const fingerprint = this.getSearchIndexFingerprint(resource);
    if (!fingerprint) {
      return;
    }
    await markSearchIndexCurrent({
      storage: this.storage,
      resource,
      fingerprint,
    });
  }

  private async clearSearchIndexComplete(resource: string): Promise<void> {
    if (!this.searchProviderResourceByName.has(resource)) {
      return;
    }
    await clearSearchIndexCurrent({
      storage: this.storage,
      resource,
    });
  }

  private async compactDeletedRecordMutations(
    mutations: any[],
  ): Promise<{
    mutations: any[];
    omittedMutationIds: Set<string>;
    replacingDeleteIdsByMutationId: Map<string, Set<string>>;
    supersedingWriteIdsByMutationId: Map<string, Set<string>>;
  }> {
    const replacingDeletesByKey = new Map<
      string,
      Array<{ index: number; mutationId: string }>
    >();
    for (const [index, mutation] of mutations.entries()) {
      if (
        mutation &&
        typeof mutation.resource === "string" &&
        typeof mutation.id === "string" &&
        mutation.operation === "delete"
      ) {
        const key = `${mutation.resource}\u0000${mutation.id}`;
        if (typeof mutation.mutationId === "string") {
          const deletes = replacingDeletesByKey.get(key) ?? [];
          deletes.push({ index, mutationId: mutation.mutationId });
          replacingDeletesByKey.set(key, deletes);
        }
      }
    }

    if (replacingDeletesByKey.size === 0) {
      return {
        mutations,
        omittedMutationIds: new Set(),
        replacingDeleteIdsByMutationId: new Map(),
        supersedingWriteIdsByMutationId: new Map(),
      };
    }

    const existingByKey = new Map<string, boolean>();
    const compacted: any[] = [];
    const omittedMutationIds = new Set<string>();
    const replacingDeleteIdsByMutationId = new Map<string, Set<string>>();
    const supersedingWriteIdsByMutationId = new Map<string, Set<string>>();
    for (const [index, mutation] of mutations.entries()) {
      if (
        mutation &&
        typeof mutation.resource === "string" &&
        typeof mutation.id === "string" &&
        isRecordMutationOperation(mutation.operation)
      ) {
        const key = `${mutation.resource}\u0000${mutation.id}`;
        const laterDeletes = (replacingDeletesByKey.get(key) ?? [])
          .filter((candidate) => candidate.index > index);
        const laterDeleteIds = laterDeletes.map(
          (candidate) => candidate.mutationId,
        );
        if (laterDeleteIds.length > 0) {
          if (!existingByKey.has(key)) {
            const existing = await this.storage.getRecord(mutation.resource, mutation.id);
            existingByKey.set(key, existing !== null);
          }
          if (existingByKey.get(key) === false) {
            if (typeof mutation.mutationId === "string") {
              omittedMutationIds.add(mutation.mutationId);
              replacingDeleteIdsByMutationId.set(
                mutation.mutationId,
                new Set(laterDeleteIds),
              );
              const firstDeleteIndex = laterDeletes[0].index;
              const supersedingWriteIds = mutations
                .slice(firstDeleteIndex + 1)
                .filter((candidate) =>
                  candidate &&
                  candidate.resource === mutation.resource &&
                  candidate.id === mutation.id &&
                  isRecordMutationOperation(candidate.operation) &&
                  typeof candidate.mutationId === "string"
                )
                .map((candidate) => candidate.mutationId as string);
              supersedingWriteIdsByMutationId.set(
                mutation.mutationId,
                new Set(supersedingWriteIds),
              );
            }
            continue;
          }
        }
      }
      compacted.push(mutation);
    }

    return {
      mutations: compacted,
      omittedMutationIds,
      replacingDeleteIdsByMutationId,
      supersedingWriteIdsByMutationId,
    };
  }

  /**
   * Perform a full clone
   * Implements HOOK-001 and EVT-003
   */
  async cloneNow() {
    const tables = this.schema.resources
      .filter((r) => !r.isRemoteOnly)
      .map((r) => r.name);

    if (tables.length === 0) {
      this.emitSyncStarted("clone", { resources: [] });
      // No tables to clone, emit success event
      this.eventBus.emit({
        type: "sync_applied",
        timestampMs: this.getTimestamp(),
        context: { phase: "clone", resources: [] },
      });
      return;
    }

    // Delegate to cloneResources which handles hooks and events
    await this.cloneResources(tables);
  }

  /**
   * Perform an incremental pull (SYNC-PULL-003)
   * Uses per-table cursors when storage is enabled (PHASE_05)
   * Implements HOOK-001 and EVT-003
   */
  async pullNow(ensureAfterInFlight = false) {
    if (this.pullInFlight) {
      if (ensureAfterInFlight) this.pullAfterReconnect = true;
      return;
    }
    this.pullInFlight = true;
    this.emitSyncStarted("pull");

    try {
      const cursors = await this.buildPullCursors();

      // Use canonical per-table cursor pull if we have cursors
      if (Object.keys(cursors).length > 0) {
        await this.pullWithPerTableCursors(cursors);
      } else {
        // No resources to pull, emit success event
        this.eventBus.emit({
          type: "sync_applied",
          timestampMs: this.getTimestamp(),
          context: { phase: "pull", resources: [] },
        });
      }
    } catch (err: any) {
      this.eventBus.emit({
        type: "sync_failed",
        timestampMs: this.getTimestamp(),
        context: {
          phase: "pull",
          error: {
            code: err.code || "INTERNAL",
            message: err.message || "Pull failed",
          },
        },
      });
    } finally {
      this.pullInFlight = false;
      // Tables this pull left to a clone that has since ended: pull again.
      if (this.pullAfterClone && this.cloningTables.size === 0) {
        this.pullAfterClone = false;
        this.pullAfterReconnect = true;
      }
      if (this.pullAfterReconnect) {
        this.pullAfterReconnect = false;
        void this.pullNow();
      }
    }
  }

  /**
   * Pull using per-table cursors (canonical protocol, PHASE_05)
   * Implements catch-up loop (CLIENT-PULL-002, CLIENT-PULL-003, CLIENT-PULL-004)
   * and HOOK-001/EVT-003 once across all iterations.
   */
  private async pullWithPerTableCursors(cursors: Record<string, string>) {
    try {
      // Prepare payload for hooks
      // CFG-001: Use configurable pullBatchSize, default to 200
      const payload = {
        clientId: this.clientId,
        cursors,
        limit: this.config?.pullBatchSize ?? 200,
        includeJoins: true,
      };

      // Run beforeSync hooks once before the loop (CLIENT-PULL-004, HOOK-001)
      const transformedPayload = await runBeforeSync(
        this.plugins,
        this.schema,
        "pull",
        payload,
      );

      // Catch-up loop (CLIENT-PULL-002, CLIENT-PULL-003)
      const maxIterations = this.config?.maxPullIterations ?? 50;
      let iterationCursors: Record<string, string> = { ...(transformedPayload as any).cursors };
      let hasMore = true;
      let iterations = 0;
      let lastResult: any = null;

      while (hasMore && iterations < maxIterations) {
        iterations++;

        // Tables a clone is writing are left to it (see cloningTables).
        const skippedKeys = this.cloningSyncKeys();
        const requestCursors = omitKeys(iterationCursors, skippedKeys);
        let leftToClone =
          Object.keys(requestCursors).length < Object.keys(iterationCursors).length;
        // Set before the request: the clone may end while it is out, and its
        // completion only schedules the catch-up pull if this is already set.
        if (leftToClone) this.pullAfterClone = true;
        const clonesStartedBefore = new Map(this.cloneStarts);
        const iterPayload = { ...(transformedPayload as object), cursors: requestCursors };
        const response: any = await this.remote.pull(iterPayload);

        if (response.ok && response.result?.ok) {
          lastResult = await decryptPullResultForE2ee(
            this.schema,
            this.e2ee,
            response.result,
          );
          // Recomputed: a clone may have started (and even ended) while the
          // request was out; its rows are newer than this response's.
          const clonedMeanwhile = new Set(this.cloningTables.keys());
          for (const [table, starts] of this.cloneStarts) {
            if (starts !== (clonesStartedBefore.get(table) ?? 0)) clonedMeanwhile.add(table);
          }
          const keysAtApply = this.cloningSyncKeys(clonedMeanwhile);
          if (keysAtApply.size > 0) leftToClone = true;
          if (leftToClone) {
            // The actor feed cursor stays where it was: the server derives
            // share and unshare effects only for requested tables, so the
            // pull after the clone must read those feed entries again for
            // the tables left out here.
            lastResult = omitPullResultKeys(
              lastResult,
              new Set([...keysAtApply, ACTOR_FEED_CURSOR_KEY]),
            );
            this.pullAfterClone = true;
          }
          const applying = applyPullResult(this.storage, lastResult);
          const applied = applying.then(
            () => undefined,
            () => undefined,
          );
          this.pullApplying = applied;
          try {
            await applying;
          } finally {
            if (this.pullApplying === applied) this.pullApplying = null;
          }
          if (this.searchProvider && !isNativeBackedSearchProvider(this.searchProvider) && lastResult) {
            if (lastResult.records) {
              for (const [resource, records] of Object.entries(lastResult.records as Record<string, unknown[]>)) {
                if ((records as unknown[]).length > 0) {
                  try {
                    await indexStoredRecords(this.searchProvider, this.storage, resource, recordIds(records as unknown[]));
                  } catch {
                    await this.clearSearchIndexComplete(resource);
                    // fail-soft
                  }
                }
              }
            }
            if (lastResult.deleted) {
              for (const [resource, ids] of Object.entries(lastResult.deleted as Record<string, string[]>)) {
                try {
                  // In its turn: removed if still deleted, re-indexed if a
                  // later write recreated it.
                  await indexStoredRecords(this.searchProvider, this.storage, resource, recordIds(
                    (ids as unknown[]).map((id) => ({ id })),
                  ));
                } catch {
                  await this.clearSearchIndexComplete(resource);
                  // fail-soft
                }
              }
            }
          }

          // A pull that left tables to a clone stops here; the pull after
          // the clone catches up from the cursors it kept.
          hasMore = lastResult.hasMore === true && !leftToClone;
          if (hasMore && lastResult.cursors) {
            // Advance cursors for the next iteration (monotonic)
            iterationCursors = { ...iterationCursors, ...lastResult.cursors };
          }
        } else {
          throw new Error(response.error?.message || "Pull rejected by server");
        }
      }

      // CLIENT-PULL-003: warn if max iterations reached while hasMore is still true
      if (iterations >= maxIterations && hasMore) {
        console.warn(
          `[datafn] Pull catch-up reached max iterations (${maxIterations}), stopping. Will resume on next sync cycle.`,
        );
      }

      if (!lastResult) {
        return;
      }

      // Run afterSync hooks once after loop exits (CLIENT-PULL-004, HOOK-001)
      await runAfterSync(
        this.plugins,
        this.schema,
        "pull",
        transformedPayload,
        lastResult,
      );

      // Calculate aggregated cursor delta (initial cursors vs final cursors)
      const cursorDelta: Record<string, number> = Object.create(null);
      if (lastResult.cursors) {
        for (const [resource, newCursor] of Object.entries(lastResult.cursors)) {
          const oldCursor = cursors[resource] || "0";
          const delta =
            parseInt(newCursor as string, 10) - parseInt(oldCursor, 10);
          if (delta > 0) {
            cursorDelta[resource] = delta;
          }
        }
      }

      // Emit sync_applied once after all iterations (CLIENT-PULL-004, EVT-003)
      this.eventBus.emit({
        type: "sync_applied",
        timestampMs: this.getTimestamp(),
        context: {
          phase: "pull",
          cursors: lastResult.cursors || {},
          cursorDelta,
          resources: lastResult.records
            ? Object.keys(lastResult.records).sort()
            : [],
        },
      });
    } catch (err: any) {
      this.eventBus.emit({
        type: "sync_failed",
        timestampMs: this.getTimestamp(),
        context: {
          phase: "pull",
          error: {
            code: err.code || "INTERNAL",
            message: err.message || "Pull failed",
          },
        },
      });
      throw err;
    }
  }

  /**
   * Perform reconcile to detect and repair drift (SYNC-007)
   * Compares local counts with server counts and triggers re-clone for mismatches
   * Implements HOOK-001 and EVT-003
   */
  async reconcileNow() {
    try {
      this.emitSyncStarted("reconcile");

      // Run beforeSync hooks (fail-closed) (HOOK-001)
      const payload = {
        clientId: this.clientId,
        resources: this.schema.resources
          .filter((r) => !r.isRemoteOnly)
          .map((r) => r.name),
        includeJoins: true,
      };

      const transformedPayload = await runBeforeSync(
        this.plugins,
        this.schema,
        "reconcile",
        payload,
      );

      // Check if remote adapter supports reconcile
      if (!this.remote.reconcile) {
        throw new Error("Remote adapter does not support reconcile");
      }

      // Call server reconcile endpoint
      const response: any = await this.remote.reconcile(transformedPayload);

      if (!response.ok || !response.result?.ok) {
        throw new Error(response.error?.message || "Reconcile rejected by server");
      }

      const result = response.result;
      const serverCounts = result.counts || {};
      const serverJoinCounts = result.joinCounts || {};

      // Compare local counts with server counts
      const mismatchedResources: string[] = [];
      const resources = (transformedPayload as any).resources;

      for (const resource of resources) {
        const localCount = await this.storage.countRecords(resource);
        const serverCount = serverCounts[resource] || 0;

        if (localCount !== serverCount) {
          mismatchedResources.push(resource);
        }
      }

      // Check join counts if includeJoins was requested
      if (this.schema.relations) {
        for (const relation of this.schema.relations) {
          if (relation.type !== "many-many") continue;

          // DI-004: from/to may be string[] — enumerate all join store key combinations
          const fromArr = Array.isArray(relation.from)
            ? relation.from as string[]
            : [relation.from as string];
          const toArr = Array.isArray(relation.to)
            ? relation.to as string[]
            : [relation.to as string];

          for (const fromTable of fromArr) {
            for (const toTable of toArr) {
              const joinStoreKey = getJoinStoreKey(fromTable, relation.relation!, toTable);
              const localJoinCount = await this.storage.countJoinRows(joinStoreKey);
              const serverJoinCount = serverJoinCounts[joinStoreKey] || 0;

              if (localJoinCount !== serverJoinCount) {
                if (!mismatchedResources.includes(fromTable)) {
                  mismatchedResources.push(fromTable);
                }
                if (!mismatchedResources.includes(toTable)) {
                  mismatchedResources.push(toTable);
                }
              }
            }
          }
        }
      }

      // Trigger re-clone for mismatched resources
      if (mismatchedResources.length > 0) {
        await this.cloneResources(mismatchedResources);
      }

      // Prepare result for hooks and events
      const reconcileResult = {
        ...result,
        reclonedResources: mismatchedResources,
      };

      // Run afterSync hooks (fail-open) (HOOK-001)
      await runAfterSync(
        this.plugins,
        this.schema,
        "reconcile",
        transformedPayload,
        reconcileResult,
      );

      // Emit sync_applied event (EVT-003)
      this.eventBus.emit({
        type: "sync_applied",
        timestampMs: this.getTimestamp(),
        context: {
          phase: "reconcile",
          reclonedResources: mismatchedResources.sort(), // Stable sort for determinism
        },
      });
    } catch (err: any) {
      // Emit sync_failed event (EVT-003)
      this.eventBus.emit({
        type: "sync_failed",
        timestampMs: this.getTimestamp(),
        context: {
          phase: "reconcile",
          error: {
            code: err.code || "INTERNAL",
            message: err.message || "Reconcile failed",
          },
        },
      });
      throw err;
    }
  }

  /**
   * Schedule a push attempt.
   * If interval is set, this is a no-op (loop handles it).
   * If no interval, schedules immediate execution.
   */
  schedulePush() {
    if (!this.pushInterval) {
      // Schedule on next tick
      setTimeout(() => this.processPush(), 0);
    }
  }

  /**
   * Compute interval backoff delay when push keeps failing
   */
  private computePushIntervalBackoff(): number {
    if (!this.pushInterval || this.pushConsecutiveFailures === 0) {
      return this.pushInterval || 0;
    }

    const backoffConfig = {
      baseMultiplier: this.config?.pushIntervalBackoff?.baseMultiplier ?? 2,
      maxDelayMs: this.config?.pushIntervalBackoff?.maxDelayMs ?? 300000, // 5 minutes
      jitterMs: this.config?.pushIntervalBackoff?.jitterMs ?? 1000,
    };

    // Exponential backoff: pushInterval * multiplier^consecutiveFailures
    const exponentialDelay =
      this.pushInterval *
      Math.pow(backoffConfig.baseMultiplier, this.pushConsecutiveFailures);

    // Add jitter
    const jitter = Math.random() * backoffConfig.jitterMs;

    // Cap at maxDelayMs
    return Math.min(exponentialDelay + jitter, backoffConfig.maxDelayMs);
  }

  /**
   * Process pending changelog entries
   */
  async processPush() {
    if (this.inFlight) {
      this.pushRerunRequested = true;
      return;
    }
    // Fast-fail: skip push when browser reports offline — saves battery and avoids doomed requests.
    // The existing retry-with-backoff logic remains authoritative for transport failures.
    if (!this.isOnline) return;
    this.inFlight = true;

    try {
      // 1. Read pending changelog
      const pending = await this.storage.changelogList({
        limit: this.pushBatchSize,
      });

      if (pending.length === 0) {
        this.inFlight = false;
        return;
      }

      this.emitSyncStarted("push", { pendingCount: pending.length });

      const firstPending = pending[0];
      const batchClientId =
        typeof firstPending.mutation?.clientId === "string"
          ? firstPending.mutation.clientId
          : firstPending.clientId;
      const clientIdMismatchIndex = pending.findIndex((entry) => {
        const entryClientId =
          typeof entry.mutation?.clientId === "string"
            ? entry.mutation.clientId
            : entry.clientId;
        return entryClientId !== batchClientId;
      });
      const batchPending = pending.slice(
        0,
        clientIdMismatchIndex === -1 ? pending.length : clientIdMismatchIndex,
      );

      const sanitizedMutations = batchPending.map((p) => {
        const mutation = sanitizeChangelogMutationForSchema(
          this.writableRecordFieldsByResource,
          this.writableRecordDefaultsByResource,
          this.writableRelationMetadataByResource,
          p.mutation,
        );
        const mutationId = getChangelogMutationId(p);
        if (
          !mutationId ||
          typeof mutation !== "object" ||
          mutation === null ||
          Array.isArray(mutation) ||
          typeof (mutation as Record<string, unknown>).mutationId === "string"
        ) {
          return mutation;
        }
        return { ...mutation, mutationId };
      });
      const compacted = await this.compactDeletedRecordMutations(
        sanitizedMutations,
      );
      let mutations = compacted.mutations;
      const batchThroughSeq = batchPending[batchPending.length - 1].seq;

      // 2. Push with retries
      let pushResult = await this.pushWithRetries(mutations, batchClientId);
      const pushResults: PushSyncResult[] = pushResult ? [pushResult] : [];

      if (
        pushResult &&
        !pushResult.ok &&
        compacted.omittedMutationIds.size > 0
      ) {
        const initiallyApplied = new Set(pushResult.applied ?? []);
        const preservedByAppliedSuccessor = new Set(
          [...compacted.supersedingWriteIdsByMutationId.entries()]
            .filter(([, writeMutationIds]) =>
              [...writeMutationIds].some(
                (writeMutationId) => initiallyApplied.has(writeMutationId),
              )
            )
            .map(([mutationId]) => mutationId),
        );
        const replayableOmittedMutationIds = new Set(
          [...compacted.replacingDeleteIdsByMutationId.entries()]
            .filter(([mutationId, deleteMutationIds]) =>
              !preservedByAppliedSuccessor.has(mutationId) &&
              [...deleteMutationIds].every(
                (deleteMutationId) => !initiallyApplied.has(deleteMutationId),
              )
            )
            .map(([mutationId]) => mutationId),
        );
        if (replayableOmittedMutationIds.size > 0) {
          // Replay only writes whose own replacing delete failed and whose
          // post-delete successor has not already applied. Replaying a prefix
          // ahead of an applied successor would let the successor deduplicate
          // instead of restoring the client's intended final state.
          mutations = sanitizedMutations.filter((mutation) => {
            const candidate = mutation as { mutationId?: unknown };
            const mutationId = typeof candidate.mutationId === "string"
              ? candidate.mutationId
              : null;
            if (!mutationId) return true;
            return !compacted.omittedMutationIds.has(mutationId) ||
              replayableOmittedMutationIds.has(mutationId);
          });
          pushResult = await this.pushWithRetries(mutations, batchClientId);
          if (!pushResult) {
            this.pushConsecutiveFailures++;
            this.applyPushIntervalBackoff();
            return;
          }
          pushResults.push(pushResult);
        }
      }

      if (pushResult) {
        const appliedAcrossAttempts = new Set(
          pushResults.flatMap((result) => result.applied ?? []),
        );
        const acknowledgedOmittedMutationIds = new Set(
          [...compacted.replacingDeleteIdsByMutationId.entries()]
            .filter(([mutationId, deleteMutationIds]) =>
              [...deleteMutationIds].some((deleteMutationId) =>
                appliedAcrossAttempts.has(deleteMutationId),
              ) ||
              [...(compacted.supersedingWriteIdsByMutationId.get(mutationId) ?? [])]
                .some((writeMutationId) =>
                  appliedAcrossAttempts.has(writeMutationId),
                )
            )
            .map(([mutationId]) => mutationId),
        );
        const throughSeq = pushResult.ok
          ? batchThroughSeq
          : computeAckThroughSeq(
              batchPending,
              pushResults,
              acknowledgedOmittedMutationIds,
            );
        if (throughSeq === null) {
          this.pushConsecutiveFailures++;
          this.applyPushIntervalBackoff();
          return;
        }

        // Success: reset consecutive failures
        this.pushConsecutiveFailures = 0;

        // If we were in backoff mode, re-establish the regular interval
        if (this.pushIntervalBackoffActive && this.pushInterval) {
          this.pushIntervalBackoffActive = false;
          // Clear any pending backoff timer
          if (this.timer) {
            clearTimeout(this.timer);
          }
          // Re-establish the regular interval
          this.timer = setInterval(() => this.processPush(), this.pushInterval);
        }

        // 3. Ack applied entries and terminal non-retryable failures
        await this.storage.changelogAck({ throughSeq });

        // 3a. Advance per-table cursors from push response (FIX-B)
        // This prevents the client from re-fetching its own changes on the next pull.
        if (pushResult.cursors) {
          for (const [resource, cursor] of Object.entries(pushResult.cursors)) {
            await setCursorMonotonically(this.storage, resource, cursor);
          }
        }

        // Trigger pull if foreign changes exist since last sync (SYNC-PULL-002)
        if (pushResult.cursor) {
          const stored =
            (await this.storage.getCursor(GLOBAL_CURSOR_KEY)) || "0";
          const storedSeq = parseInt(stored, 10);

          if (pushResult.cursorBefore !== undefined) {
            // cursorBefore = global seq before this push allocated any sequences.
            // If cursorBefore == storedSeq, no other client wrote changes since our last
            // pull — advance the global cursor locally and skip the redundant pull.
            // If cursorBefore != storedSeq, foreign changes exist — pull to fetch them.
            const beforeSeq = parseInt(pushResult.cursorBefore, 10);
            if (beforeSeq === storedSeq) {
              // No foreign changes — advance cursor locally (global) and skip pull
              await setCursorMonotonically(this.storage, GLOBAL_CURSOR_KEY, pushResult.cursor);
            } else {
              // Foreign changes exist — pull to fetch them
              setTimeout(() => this.pullNow(), 0);
            }
          } else {
            // Server did not return cursorBefore; use cursor comparison.
            const serverSeq = parseInt(pushResult.cursor, 10);
            if (serverSeq > storedSeq) {
              setTimeout(() => this.pullNow(), 0);
            }
          }
        }

        // If we filled the batch, there might be more
        if (
          throughSeq < batchThroughSeq ||
          batchPending.length < pending.length ||
          pending.length === this.pushBatchSize
        ) {
          // Schedule next batch immediately
          setTimeout(() => this.processPush(), 0);
        }
      } else {
        // Failure: increment consecutive failures and apply interval backoff
        this.pushConsecutiveFailures++;
        this.applyPushIntervalBackoff();
      }
    } catch (err) {
      console.error("Sync engine internal error", err);
    } finally {
      this.inFlight = false;
      if (this.pushRerunRequested) {
        this.pushRerunRequested = false;
        setTimeout(() => this.processPush(), 0);
      }
    }
  }

  /**
   * Push mutations with retry policy
   * Returns result if successful, null if exhausted retries
   * Implements HOOK-001, EVT-003, and RET-001 (exponential backoff)
   */
  private async pushWithRetries(
    mutations: any[],
    clientId = this.clientId,
  ): Promise<PushSyncResult | null> {
    let attempt = 0;
    // Initial attempt (0) + retries
    const maxAttempts = 1 + this.pushMaxRetries;

    // Get backoff configuration (PHASE_08: RET-001)
    const backoffConfig = {
      baseDelayMs: this.config?.pushRetryBackoff?.baseDelayMs ?? 1000,
      multiplier: this.config?.pushRetryBackoff?.multiplier ?? 2,
      maxDelayMs: this.config?.pushRetryBackoff?.maxDelayMs ?? 60000,
      jitterMs: this.config?.pushRetryBackoff?.jitterMs ?? 500,
    };

    // Prepare payload for hooks
    const payload = {
      clientId,
      mutations,
    };

    // Run beforeSync hooks (fail-closed) (HOOK-001)
    let transformedPayload: any;
    let payloadForRemote: any;
    try {
      transformedPayload = await runBeforeSync(
        this.plugins,
        this.schema,
        "push",
        payload,
      );
      payloadForRemote = await encryptPushPayloadForE2ee(
        this.schema,
        this.e2ee,
        transformedPayload,
      );
    } catch (err: any) {
      // beforeSync failed, emit sync_failed and return
      this.eventBus.emit({
        type: "sync_failed",
        timestampMs: this.getTimestamp(),
        context: {
          phase: "push",
          error: {
            code: err.code || "INTERNAL",
            message: err.message || "Push beforeSync hook failed",
          },
        },
      });
      return null;
    }

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const response: any = await this.remote.push(payloadForRemote);

        if (response.result && (response.ok || hasTerminalMutationError(response.result))) {
          const result = response.result as PushSyncResult;

          // Run afterSync hooks (fail-open) (HOOK-001)
          await runAfterSync(
            this.plugins,
            this.schema,
            "push",
            transformedPayload,
            result,
          );

          // Emit sync_applied/sync_failed event (EVT-003)
          this.eventBus.emit({
            type: result.ok ? "sync_applied" : "sync_failed",
            timestampMs: this.getTimestamp(),
            context: {
              phase: "push",
              cursor: result.cursor || null,
              appliedCount: result.applied ? result.applied.length : 0,
              errors: result.errors ?? [],
            },
          });

          return result;
        } else {
          // Protocol error (e.g. invalid clientId) or server rejection
          throw Object.assign(new Error(response.error?.message || "Push rejected by server"), {
            code: response.error?.code, retryable: response.error?.details?.retryable,
          });
        }
      } catch (err: any) {
        // If this was the last attempt
        if (attempt === maxAttempts || err.retryable === false) {
          this.eventBus.emit({
            type: "sync_failed",
            timestampMs: this.getTimestamp(),
            context: {
              phase: "push",
              attempts: attempt,
              error: {
                code: err.code || "INTERNAL",
                message: err.message || "Push failed",
              },
            },
          });
          return null;
        }
        
        // Compute backoff delay (PHASE_08: RET-001)
        // Note: attempt is 1-indexed (first attempt is 1), so use attempt-1 for backoff calculation
        const delay = computeBackoffDelay(attempt - 1, backoffConfig);
        
        // Emit sync_retry event (PHASE_08: RET-001)
        this.eventBus.emit({
          type: "sync_retry",
          timestampMs: this.getTimestamp(),
          context: {
            phase: "push",
            attempt,
            delayMs: delay,
          },
        });
        
        // Wait before next retry
        await sleep(delay);
        // Loop to retry
      }
    }

    return null;
  }

  private applyPushIntervalBackoff(): void {
    if (!this.pushInterval) return;

    if (this.timer && !this.pushIntervalBackoffActive) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pushIntervalBackoffActive = true;

    const backoffDelay = this.computePushIntervalBackoff();
    this.timer = setTimeout(() => {
      this.processPush();
    }, backoffDelay);
  }

  private emitSyncStarted(
    phase: DatafnSyncPhase,
    context: Record<string, unknown> = {},
  ): void {
    this.eventBus.emit({
      type: "sync_started",
      timestampMs: this.getTimestamp(),
      context: {
        ...context,
        phase,
      },
    });
  }
}
