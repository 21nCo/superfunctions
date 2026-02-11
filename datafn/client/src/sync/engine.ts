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
import type { DatafnSchema, DatafnPlugin } from "@datafn/core";
import {
  applyCloneResult,
  applyPullResult,
  GLOBAL_CURSOR_KEY,
  type CloneResult,
  type PullResult,
} from "./apply.js";
import { runBeforeSync, runAfterSync } from "../plugins/run-hooks.js";

/**
 * Helper: Sleep for a given number of milliseconds (PHASE_08)
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

export class SyncEngine {
  private inFlight = false;
  private pullInFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pushBatchSize = 100;
  private pushMaxRetries = 3;
  private pushInterval: number | undefined;
  private boundOnVisibilityChange: () => void;
  private ws: WebSocket | null = null;
  private wsUrl: string | undefined;
  private hydrationPlan?: {
    bootResources?: string[];
    backgroundResources?: string[];
    clonePageSize?: number | Record<string, number>;
  };
  private plugins: DatafnPlugin[] = [];
  private getTimestamp: () => number;
  private wsReconnectAttempt = 0;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsReconnectEnabled = true;
  private config?: DatafnSyncConfig;

  constructor(
    private storage: DatafnStorageAdapter,
    private remote: DatafnRemoteAdapter,
    private eventBus: EventBus,
    private clientId: string,
    private schema: DatafnSchema,
    config?: DatafnSyncConfig,
    plugins?: DatafnPlugin[],
    getTimestamp?: () => number,
  ) {
    this.config = config;
    this.pushBatchSize = config?.pushBatchSize ?? 100;
    this.pushMaxRetries = config?.pushMaxRetries ?? 3;
    this.pushInterval = config?.pushInterval;
    this.boundOnVisibilityChange = this.onVisibilityChange.bind(this);
    this.hydrationPlan = config?.hydration;
    this.plugins = plugins || [];
    this.getTimestamp = getTimestamp || (() => Date.now());

    if (config?.ws && config?.remote) {
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
    // 1. Initial sync
    await this.initializeSync();

    // 2. Start push loop
    if (this.pushInterval) {
      this.timer = setInterval(() => this.processPush(), this.pushInterval);
    }

    // 3. Register visibility listener
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener(
        "visibilitychange",
        this.boundOnVisibilityChange,
      );
    }

    // 4. Connect WebSocket
    if (this.wsUrl) {
      this.connectWs();
    }
  }

  /**
   * Stop the sync loop
   */
  stop() {
    // Disable reconnection
    this.wsReconnectEnabled = false;
    
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
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Connect WebSocket for real-time updates
   */
  private connectWs() {
    if (typeof WebSocket === "undefined" || !this.wsUrl) return;

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = async () => {
        // Reset reconnection attempt counter on successful connection
        this.wsReconnectAttempt = 0;
        
        // Build per-table cursors map from all known resources
        const cursors: Record<string, string> = {};
        
        for (const res of this.schema.resources) {
          if (res.isRemoteOnly) continue;
          
          // Get per-table cursor, default to "0" if not set
          const cursor = await this.storage.getCursor(res.name) || "0";
          cursors[res.name] = cursor;
        }
        
        // Send hello with current cursors
        this.ws?.send(
          JSON.stringify({
            type: "hello",
            clientId: this.clientId,
            cursors,
          }),
        );
        
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
              this.pullNow();
            }
          }
        } catch (e) {
          // Ignore invalid messages
        }
      };

      this.ws.onerror = (e) => {
        console.error("WebSocket error:", e);
      };

      this.ws.onclose = () => {
        this.ws = null;
        
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
      console.error("Failed to connect WebSocket:", e);
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
   */
  private async initializeWithHydrationPlan() {
    const { bootResources = [], backgroundResources = [] } = this.hydrationPlan!;

    // Clone boot resources and wait for them to be ready
    if (bootResources.length > 0) {
      await this.cloneResources(bootResources);
    }

    // Clone background resources asynchronously
    if (backgroundResources.length > 0) {
      // Start background clone without blocking
      this.cloneResourcesInBackground(backgroundResources);
    }
  }

  /**
   * Clone specific resources and wait for completion
   * Implements HOOK-001 and EVT-003
   */
  private async cloneResources(tables: string[]) {
    try {
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
      let result: CloneResult;
      
      if (pageSize && pageSize < 1000) {
        // Use pagination
        for (const table of tables) {
          await this.cloneTablePaginated(table, pageSize);
        }
        // Create a synthetic result for event emission
        result = { ok: true, data: {}, cursors: {}, next: null };
      } else {
        // Clone all at once
        const response: any = await this.remote.clone(transformedPayload);

        if (response.ok && response.result?.ok) {
          result = response.result as CloneResult;
          await applyCloneResult(this.storage, result);
        } else {
          throw new Error(response.error?.message || "Clone rejected by server");
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
    // Schedule async clone without blocking
    setTimeout(async () => {
      await this.cloneResources(tables);
    }, 0);
  }

  /**
   * Clone a single table with pagination
   */
  private async cloneTablePaginated(table: string, pageSize: number) {
    let afterId: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const response: any = await this.remote.clone({
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
        await applyCloneResult(this.storage, response.result as CloneResult);
        
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

  /**
   * Perform a full clone
   * Implements HOOK-001 and EVT-003
   */
  async cloneNow() {
    const tables = this.schema.resources
      .filter((r) => !r.isRemoteOnly)
      .map((r) => r.name);

    if (tables.length === 0) {
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
  async pullNow() {
    if (this.pullInFlight) return;
    this.pullInFlight = true;

    try {
      // Build per-table cursors map from all known resources
      const cursors: Record<string, string> = {};
      
      for (const res of this.schema.resources) {
        if (res.isRemoteOnly) continue;
        
        // Get per-table cursor, default to "0" if not set
        const cursor = await this.storage.getCursor(res.name) || "0";
        cursors[res.name] = cursor;
      }

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
    }
  }

  /**
   * Pull using per-table cursors (canonical protocol, PHASE_05)
   * Implements HOOK-001 and EVT-003
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

      // Run beforeSync hooks (fail-closed) (HOOK-001)
      const transformedPayload = await runBeforeSync(
        this.plugins,
        this.schema,
        "pull",
        payload,
      );

      const response: any = await this.remote.pull(transformedPayload);

      if (response.ok && response.result?.ok) {
        const result = response.result;
        
        // Import apply function with proper types
        const { applyPullResult } = await import("./apply.js");
        await applyPullResult(this.storage, result);

        // Run afterSync hooks (fail-open) (HOOK-001)
        await runAfterSync(
          this.plugins,
          this.schema,
          "pull",
          transformedPayload,
          result,
        );

        // Calculate cursor delta (difference) for event
        const cursorDelta: Record<string, number> = {};
        if (result.cursors) {
          for (const [resource, newCursor] of Object.entries(result.cursors)) {
            const oldCursor = cursors[resource] || "0";
            const delta = parseInt(newCursor as string, 10) - parseInt(oldCursor, 10);
            if (delta > 0) {
              cursorDelta[resource] = delta;
            }
          }
        }

        // Emit sync_applied event (EVT-003)
        this.eventBus.emit({
          type: "sync_applied",
          timestampMs: this.getTimestamp(),
          context: {
            phase: "pull",
            cursors: result.cursors || {},
            cursorDelta,
            resources: result.records ? Object.keys(result.records).sort() : [],
          },
        });
      } else {
        throw new Error(response.error?.message || "Pull rejected by server");
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

          const joinStoreKey = `join_${relation.from}_${relation.relation}_${relation.to}`;
          const localJoinCount = await this.storage.countJoinRows(joinStoreKey);
          const serverJoinCount = serverJoinCounts[joinStoreKey] || 0;

          if (localJoinCount !== serverJoinCount) {
            // Add both resources involved in this relation to rehydrate
            if (!mismatchedResources.includes(relation.from)) {
              mismatchedResources.push(relation.from);
            }
            if (!mismatchedResources.includes(relation.to)) {
              mismatchedResources.push(relation.to);
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
   * Process pending changelog entries
   */
  async processPush() {
    if (this.inFlight) return;
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

      const mutations = pending.map((p) => p.mutation);
      const throughSeq = pending[pending.length - 1].seq;

      // 2. Push with retries
      const pushResult = await this.pushWithRetries(mutations);

      if (pushResult) {
        // 3. Ack on success
        await this.storage.changelogAck({ throughSeq });

        // Trigger pull if server is ahead (SYNC-PULL-002)
        if (pushResult.cursor) {
          const stored =
            (await this.storage.getCursor(GLOBAL_CURSOR_KEY)) || "0";
          const serverSeq = parseInt(pushResult.cursor, 10);
          const storedSeq = parseInt(stored, 10);

          if (serverSeq > storedSeq) {
            // Trigger pull asynchronously
            setTimeout(() => this.pullNow(), 0);
          }
        }

        // If we filled the batch, there might be more
        if (pending.length === this.pushBatchSize) {
          // Schedule next batch immediately
          setTimeout(() => this.processPush(), 0);
        }
      }
    } catch (err) {
      console.error("Sync engine internal error", err);
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Push mutations with retry policy
   * Returns result if successful, null if exhausted retries
   * Implements HOOK-001, EVT-003, and RET-001 (exponential backoff)
   */
  private async pushWithRetries(
    mutations: any[],
  ): Promise<{ ok: boolean; cursor?: string } | null> {
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
      clientId: this.clientId,
      mutations,
    };

    // Run beforeSync hooks (fail-closed) (HOOK-001)
    let transformedPayload: any;
    try {
      transformedPayload = await runBeforeSync(
        this.plugins,
        this.schema,
        "push",
        payload,
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
        const response: any = await this.remote.push(transformedPayload);

        if (response.ok && response.result?.ok) {
          const result = response.result;

          // Run afterSync hooks (fail-open) (HOOK-001)
          await runAfterSync(
            this.plugins,
            this.schema,
            "push",
            transformedPayload,
            result,
          );

          // Emit sync_applied event (EVT-003)
          this.eventBus.emit({
            type: "sync_applied",
            timestampMs: this.getTimestamp(),
            context: {
              phase: "push",
              cursor: result.cursor || null,
              appliedCount: result.applied ? result.applied.length : 0,
            },
          });

          // Success (backoff resets on next call)
          return result;
        } else {
          // Protocol error (e.g. invalid clientId) or server rejection
          throw new Error(response.error?.message || "Push rejected by server");
        }
      } catch (err: any) {
        // If this was the last attempt
        if (attempt === maxAttempts) {
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
}
