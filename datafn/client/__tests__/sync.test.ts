/**
 * Sync Facade Tests - Phase 05
 * Tests TV-SYNC-001, TV-SYNC-002, TV-PUSH-002, TV-PUSH-003, TV-PULL-001, TV-PULL-002, TV-PULL-005, TV-PULL-006
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDatafnClient } from "../src/client.js";
import { DefaultHttpTransport } from "../src/transport/http.js";
import type {
  DatafnStorageAdapter,
  DatafnHydrationState,
  DatafnChangelogEntry,
} from "../src/index.js";

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: () => void = () => {};
  onmessage: (event: { data: string }) => void = () => {};
  onclose: () => void = () => {};
  onerror: (e: any) => void = () => {};
  send = vi.fn();
  close = vi.fn();

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen(), 0);
  }
}

// Mock storage adapter for testing
class MockStorageAdapter implements DatafnStorageAdapter {
  public records = new Map<string, Map<string, Record<string, unknown>>>();
  public changelog: Array<DatafnChangelogEntry> = [];
  public hydrationStates = new Map<string, DatafnHydrationState>();
  public cursors = new Map<string, string>();

  async getRecord(
    resource: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const resourceRecords = this.records.get(resource);
    return resourceRecords?.get(id) || null;
  }

  async listRecords(resource: string): Promise<Record<string, unknown>[]> {
    const resourceRecords = this.records.get(resource);
    return resourceRecords ? Array.from(resourceRecords.values()) : [];
  }

  async upsertRecord(
    resource: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    if (!this.records.has(resource)) {
      this.records.set(resource, new Map());
    }
    this.records.get(resource)!.set(record.id as string, record);
  }

  async deleteRecord(resource: string, id: string): Promise<void> {
    this.records.get(resource)?.delete(id);
  }

  async getCursor(resource: string): Promise<string | null> {
    return this.cursors.get(resource) || null;
  }
  async setCursor(resource: string, cursor: string): Promise<void> {
    this.cursors.set(resource, cursor);
  }
  async getHydrationState(resource: string): Promise<DatafnHydrationState> {
    return this.hydrationStates.get(resource) || "notStarted";
  }
  async setHydrationState(
    resource: string,
    state: DatafnHydrationState,
  ): Promise<void> {
    this.hydrationStates.set(resource, state);
  }

  async listJoinRows(
    relationKey: string,
  ): Promise<Array<Record<string, unknown>>> {
    return [];
  }
  async upsertJoinRow(
    relationKey: string,
    row: Record<string, unknown>,
  ): Promise<void> {}
  async deleteJoinRow(
    relationKey: string,
    from: string,
    to: string,
  ): Promise<void> {}

  async changelogAppend(
    entry: Omit<DatafnChangelogEntry, "seq">,
  ): Promise<DatafnChangelogEntry> {
    const seq = this.changelog.length + 1;
    const fullEntry = { ...entry, seq };
    this.changelog.push(fullEntry);
    return fullEntry;
  }

  async changelogList(options?: {
    limit?: number;
  }): Promise<DatafnChangelogEntry[]> {
    return options?.limit
      ? this.changelog.slice(0, options.limit)
      : this.changelog;
  }

  async changelogAck(options: { throughSeq: number }): Promise<void> {
    this.changelog = this.changelog.filter((e) => e.seq > options.throughSeq);
  }

  async getJoinRows(
    relationKey: string,
    fromId: string,
  ): Promise<Array<Record<string, unknown>>> {
    return [];
  }

  async setJoinRows(
    relationKey: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {}

  async findRecords(
    resource: string,
    field: string,
    value: unknown,
  ): Promise<Record<string, unknown>[]> {
    const records = await this.listRecords(resource);
    return records.filter((r) => r[field] === value);
  }
}

// Default schema for testing
const defaultSchema = {
  resources: [
    {
      name: "task",
      version: 1,
      fields: [{ name: "title", type: "string" as const, required: true }],
    },
    {
      name: "user",
      version: 1,
      fields: [{ name: "name", type: "string" as const, required: true }],
    },
  ],
};

describe("@datafn/client sync", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("TV-SYNC-001: Sync methods delegate and unwrap", async () => {
    const spies = {
      seed: vi
        .spyOn(DefaultHttpTransport.prototype, "seed")
        .mockResolvedValue({ ok: true, result: { ok: true } }),
      clone: vi
        .spyOn(DefaultHttpTransport.prototype, "clone")
        .mockResolvedValue({ ok: true, result: { ok: true } }),
      pull: vi
        .spyOn(DefaultHttpTransport.prototype, "pull")
        .mockResolvedValue({ ok: true, result: { ok: true } }),
      push: vi
        .spyOn(DefaultHttpTransport.prototype, "push")
        .mockResolvedValue({ ok: true, result: { ok: true } }),
    };

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: { remote: "http://example.com" },
      clientId: "test-client",
      getTimestamp: () => 0,
    });

    await client.sync.seed({ clientId: "client:1" });
    expect(spies.seed).toHaveBeenCalled();
  });

  it("TV-PUSH-002: Push retries are capped; exceeding max retries emits sync_failed", async () => {
    const storage = new MockStorageAdapter();
    // Preload changelog
    await storage.changelogAppend({
      clientId: "c1",
      mutationId: "m1",
      timestampMs: 1,
      mutation: { resource: "task", operation: "merge", id: "t1" },
    });

    // Mock clone/pull because start() calls them
    vi.spyOn(DefaultHttpTransport.prototype, "clone").mockResolvedValue({
      ok: true,
      result: { ok: true, data: {}, cursors: {} },
    });
    vi.spyOn(DefaultHttpTransport.prototype, "pull").mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        changes: [],
        nextCursor: null,
      },
    });

    const pushSpy = vi
      .spyOn(DefaultHttpTransport.prototype, "push")
      .mockRejectedValue({ code: "TRANSPORT_ERROR" });

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: {
        offlinability: true,
        remote: "http://example.com",
        pushMaxRetries: 3,
        pushInterval: 20000, // Long interval to prevent second cycle
      },
      clientId: "c1",
      storage,
    });

    // Subscribe to events
    const eventHandler = vi.fn();
    client.subscribe(eventHandler);

    // Start sync engine
    await client.sync.start();

    // Fast forward enough for initial attempt + 3 retries with backoff delays
    // Default backoff: 1000ms (+ jitter 0-500), 2000ms (+ jitter), 4000ms (+ jitter)
    await vi.advanceTimersByTimeAsync(20000); // Initial interval
    await vi.advanceTimersByTimeAsync(1500);  // First retry delay
    await vi.advanceTimersByTimeAsync(2500);  // Second retry delay
    await vi.advanceTimersByTimeAsync(4500);  // Third retry delay
    await vi.advanceTimersByTimeAsync(100);   // Buffer

    expect(pushSpy).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(eventHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sync_failed",
        context: expect.objectContaining({
          phase: "push",
          attempts: 4,
        }),
      }),
    );

    client.sync.stop();
  });

  it("TV-PUSH-003: pushBatchSize default is 100", async () => {
    const storage = new MockStorageAdapter();
    // Fill changelog with 150 items
    for (let i = 0; i < 150; i++) {
      await storage.changelogAppend({
        clientId: "c1",
        mutationId: `m${i}`,
        timestampMs: 1,
        mutation: { resource: "task", operation: "merge", id: `t${i}` },
      });
    }

    // Mock clone/pull
    vi.spyOn(DefaultHttpTransport.prototype, "clone").mockResolvedValue({
      ok: true,
      result: { ok: true, data: {}, cursors: {} },
    });

    const pushSpy = vi
      .spyOn(DefaultHttpTransport.prototype, "push")
      .mockResolvedValue({ ok: true, result: { ok: true } });

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: {
        offlinability: true,
        remote: "http://example.com",
        pushInterval: 1000,
        // pushBatchSize omitted -> default 100
      },
      clientId: "c1",
      storage,
    });

    await client.sync.start();
    await vi.advanceTimersByTimeAsync(1100);

    // Should have called push twice (100 then 50) because processPush schedules immediate next batch if full
    expect(pushSpy).toHaveBeenCalled();
    const firstCall = pushSpy.mock.calls[0][0] as any;
    expect(firstCall.mutations).toHaveLength(100);

    // Check if second call happened (due to immediate reschedule)
    // We need to wait for the immediate timeout
    await vi.advanceTimersByTimeAsync(0);

    expect(pushSpy).toHaveBeenCalledTimes(2);
    const secondCall = pushSpy.mock.calls[1][0] as any;
    expect(secondCall.mutations).toHaveLength(50);

    client.sync.stop();
  });

  it("TV-PULL-001: Initialization calls clone for fresh install", async () => {
    const storage = new MockStorageAdapter();
    // Hydration state is 'notStarted' by default

    const cloneSpy = vi
      .spyOn(DefaultHttpTransport.prototype, "clone")
      .mockResolvedValue({
        ok: true,
        result: { ok: true, data: {}, cursors: {} },
      });
    const pullSpy = vi.spyOn(DefaultHttpTransport.prototype, "pull");

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: { offlinability: true, remote: "http://example.com" },
      clientId: "c1",
      storage,
    });

    await client.sync.start();

    expect(cloneSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tables: expect.arrayContaining(["task", "user"]) }),
    );
    expect(pullSpy).not.toHaveBeenCalled();

    client.sync.stop();
  });

  it("TV-PULL-001 (Hydrated): Initialization calls pull for hydrated install", async () => {
    const storage = new MockStorageAdapter();
    storage.hydrationStates.set("task", "ready");
    storage.hydrationStates.set("user", "ready");
    storage.hydrationStates.set("kv", "ready");
    // Set per-table cursors
    storage.cursors.set("task", "0");
    storage.cursors.set("user", "0");
    storage.cursors.set("kv", "0");

    const cloneSpy = vi.spyOn(DefaultHttpTransport.prototype, "clone").mockResolvedValue({
      ok: true,
      result: { ok: true, data: {}, cursors: {} },
    });
    const pullSpy = vi
      .spyOn(DefaultHttpTransport.prototype, "pull")
      .mockResolvedValue({
        ok: true,
        result: {
          ok: true,
          records: {},
          deleted: {},
          cursors: { task: "0", user: "0", kv: "0" },
        },
      });

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: { offlinability: true, remote: "http://example.com" },
      clientId: "c1",
      storage,
    });

    await client.sync.start();

    expect(cloneSpy).not.toHaveBeenCalled();
    expect(pullSpy).toHaveBeenCalled();
    // Verify pull was called with per-table cursors
    expect(pullSpy).toHaveBeenCalledWith(
      expect.objectContaining({ 
        cursors: expect.objectContaining({ task: "0", user: "0", kv: "0" })
      }),
    );

    client.sync.stop();
  });

  it("TV-PULL-002: Pull paginates using cursor", async () => {
    const storage = new MockStorageAdapter();
    storage.hydrationStates.set("task", "ready");
    storage.hydrationStates.set("user", "ready");
    storage.hydrationStates.set("kv", "ready");
    // Set per-table cursors
    storage.cursors.set("task", "10");
    storage.cursors.set("user", "10");
    storage.cursors.set("kv", "10");

    const pullSpy = vi
      .spyOn(DefaultHttpTransport.prototype, "pull")
      .mockResolvedValueOnce({
        ok: true,
        result: {
          ok: true,
          records: {},
          deleted: {},
          cursors: { task: "20", user: "20", kv: "20" },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          ok: true,
          records: {},
          deleted: {},
          cursors: { task: "20", user: "20", kv: "20" },
        },
      });

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: { offlinability: true, remote: "http://example.com" },
      clientId: "c1",
      storage,
    });

    await client.sync.start();

    expect(pullSpy).toHaveBeenCalledTimes(1);
    expect(pullSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ 
        cursors: expect.objectContaining({ task: "10", user: "10", kv: "10" })
      }),
    );

    // Verify stored cursor updated
    expect(storage.cursors.get("task")).toBe("20");

    client.sync.stop();
  });

  it("TV-PULL-005: After successful push with newer cursor, trigger pull", async () => {
    const storage = new MockStorageAdapter();
    // Preload changelog
    await storage.changelogAppend({
      clientId: "c1",
      mutationId: "m1",
      timestampMs: 1,
      mutation: { resource: "task", operation: "merge", id: "t1" },
    });
    // Set per-table cursors
    storage.cursors.set("task", "10");
    storage.cursors.set("user", "10");
    storage.cursors.set("kv", "10");
    storage.cursors.set("__global_cursor__", "10");
    storage.hydrationStates.set("task", "ready");
    storage.hydrationStates.set("user", "ready");
    storage.hydrationStates.set("kv", "ready");

    // Push returns newer cursor
    const pushSpy = vi
      .spyOn(DefaultHttpTransport.prototype, "push")
      .mockResolvedValue({
        ok: true,
        result: { ok: true, applied: ["m1"], cursor: "20", errors: [] },
      });

    const pullSpy = vi
      .spyOn(DefaultHttpTransport.prototype, "pull")
      .mockResolvedValue({
        ok: true,
        result: { 
          ok: true, 
          records: {}, 
          deleted: {}, 
          cursors: { task: "20", user: "20", kv: "20" } 
        },
      });

    // Initialization calls (clone/pull) need mocks too
    vi.spyOn(DefaultHttpTransport.prototype, "clone").mockResolvedValue({
      ok: true,
      result: { ok: true, data: {}, cursors: { task: "10", user: "10", kv: "10" } },
    });

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: {
        offlinability: true,
        remote: "http://example.com",
        pushInterval: 1000,
      },
      clientId: "c1",
      storage,
    });

    await client.sync.start();

    // Trigger processPush manually or wait for interval
    await vi.advanceTimersByTimeAsync(1100);

    expect(pushSpy).toHaveBeenCalled();

    // Wait for pull triggering (async setTimeout 0)
    await vi.advanceTimersByTimeAsync(0);

    expect(pullSpy).toHaveBeenCalled();
    expect(pullSpy).toHaveBeenCalledWith(
      expect.objectContaining({ 
        cursors: expect.objectContaining({ task: "10", user: "10", kv: "10" })
      }),
    ); // Should pull from existing stored cursor, NOT the pushed one (since we want catchup)
    // Wait, pullNow uses stored cursor. If we haven't updated it yet, it's 10.
    // The pushed cursor 20 tells us "server is at 20".
    // We are at 10. So we pull.
    // If pull succeeds, we update to 20 (or whatever pull returns).

    client.sync.stop();
  });

  it("TV-PULL-006: Push returns same/older cursor, no pull", async () => {
    const storage = new MockStorageAdapter();
    await storage.changelogAppend({
      clientId: "c1",
      mutationId: "m1",
      timestampMs: 1,
      mutation: { resource: "task", operation: "merge", id: "t1" },
    });
    storage.cursors.set("__global_cursor__", "20");

    // Push returns same cursor
    const pushSpy = vi
      .spyOn(DefaultHttpTransport.prototype, "push")
      .mockResolvedValue({
        ok: true,
        result: { ok: true, cursor: "20" },
      });

    const pullSpy = vi
      .spyOn(DefaultHttpTransport.prototype, "pull")
      .mockResolvedValue({ ok: true, result: { ok: true } });

    vi.spyOn(DefaultHttpTransport.prototype, "clone").mockResolvedValue({
      ok: true,
      result: { ok: true, data: {}, cursors: {} },
    });

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: {
        offlinability: true,
        remote: "http://example.com",
        pushInterval: 1000,
      },
      clientId: "c1",
      storage,
    });

    await client.sync.start();
    await vi.advanceTimersByTimeAsync(1100);

    expect(pushSpy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);

    // Should NOT trigger pull
    expect(pullSpy).not.toHaveBeenCalled();

    client.sync.stop();
  });

  it("TV-WS-001: Server cursor notification triggers pull", async () => {
    const storage = new MockStorageAdapter();
    storage.cursors.set("__global_cursor__", "10");

    // Mock pull (triggered by ws)
    const pullSpy = vi
      .spyOn(DefaultHttpTransport.prototype, "pull")
      .mockResolvedValue({
        ok: true,
        result: { ok: true, changes: [], nextCursor: null },
      });

    vi.spyOn(DefaultHttpTransport.prototype, "clone").mockResolvedValue({
      ok: true,
      result: { ok: true, data: {}, cursors: {} },
    });

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: {
        offlinability: true,
        remote: "http://example.com",
        ws: true,
      },
      clientId: "c1",
      storage,
    });

    await client.sync.start();
    await vi.runAllTimersAsync();

    // Verify WS connected
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe("ws://example.com/ws");

    // Simulate cursor message > 10
    ws.onmessage({
      data: JSON.stringify({ type: "cursor", cursor: "20" }),
    });

    await vi.runAllTimersAsync(); // Allow pullNow to run

    expect(pullSpy).toHaveBeenCalled();
  });

  it("TV-WS-002: Unknown WebSocket messages do not trigger pull", async () => {
    const storage = new MockStorageAdapter();
    const pullSpy = vi.spyOn(DefaultHttpTransport.prototype, "pull");

    vi.spyOn(DefaultHttpTransport.prototype, "clone").mockResolvedValue({
      ok: true,
      result: { ok: true, data: {}, cursors: {} },
    });

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: {
        offlinability: true,
        remote: "http://example.com",
        ws: true,
      },
      clientId: "c1",
      storage,
    });

    await client.sync.start();
    await vi.runAllTimersAsync();

    const ws = MockWebSocket.instances[0];

    // Simulate unknown message
    ws.onmessage({
      data: JSON.stringify({ type: "unknown", foo: "bar" }),
    });

    await vi.runAllTimersAsync();

    expect(pullSpy).not.toHaveBeenCalled();
  });

  // PHASE_06 Tests
  it("TV-SYNC-002: Hydration plan hydrates boot resources before background resources", async () => {
    const storage = new MockStorageAdapter();
    
    // Track clone calls to verify ordering
    const cloneCalls: string[][] = [];
    
    vi.spyOn(DefaultHttpTransport.prototype, "clone").mockImplementation(async (payload: any) => {
      cloneCalls.push(payload.tables);
      
      // Return successful clone result
      const data: Record<string, any[]> = {};
      const cursors: Record<string, string> = {};
      
      for (const table of payload.tables) {
        data[table] = [];
        cursors[table] = "1";
      }
      
      return {
        ok: true,
        result: { ok: true, data, cursors },
      };
    });

    const schema = {
      resources: [
        { name: "goal", version: 1, fields: [] },
        { name: "node", version: 1, fields: [] },
      ],
      relations: [],
    };

    const client = createDatafnClient({
      schema,
      sync: {
        offlinability: true,
        remote: "http://example.com",
        hydration: {
          bootResources: ["goal"],
          backgroundResources: ["node"],
        },
      },
      clientId: "c1",
      storage,
    });

    await client.sync.start();
    await vi.runAllTimersAsync();

    // Verify goal was cloned first
    expect(cloneCalls.length).toBeGreaterThanOrEqual(2);
    expect(cloneCalls[0]).toContain("goal");
    
    // Verify goal is ready
    const goalState = await storage.getHydrationState("goal");
    expect(goalState).toBe("ready");
  });

  it("TV-SYNC-002N: Query on hydrating table uses remote fallback when available", async () => {
    const storage = new MockStorageAdapter();
    
    // Set task to hydrating state
    await storage.setHydrationState("task", "hydrating");

    const querySpy = vi.spyOn(DefaultHttpTransport.prototype, "query").mockResolvedValue({
      ok: true,
      result: { data: [], nextCursor: null },
    });

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: {
        offlinability: true,
        remote: "http://example.com",
      },
      clientId: "c1",
      storage,
    });

    // Query the hydrating table
    await client.task.query({ resource: "task", version: 1, select: ["id"] });

    // Should have used remote fallback
    expect(querySpy).toHaveBeenCalled();
  });

  // PHASE_08 Tests - RET-001: Push Retry Exponential Backoff
  it("TV-RET-001: Push retries with increasing delays (exponential backoff)", async () => {
    const storage = new MockStorageAdapter();
    // Preload changelog
    await storage.changelogAppend({
      clientId: "c1",
      mutationId: "m1",
      timestampMs: 1,
      mutation: { resource: "task", operation: "merge", id: "t1" },
    });

    // Mock clone/pull
    vi.spyOn(DefaultHttpTransport.prototype, "clone").mockResolvedValue({
      ok: true,
      result: { ok: true, data: {}, cursors: {} },
    });
    vi.spyOn(DefaultHttpTransport.prototype, "pull").mockResolvedValue({
      ok: true,
      result: { ok: true, records: {}, deleted: {}, cursors: {} },
    });

    // Push fails 3 times, then succeeds
    let callCount = 0;
    const pushSpy = vi
      .spyOn(DefaultHttpTransport.prototype, "push")
      .mockImplementation(async () => {
        callCount++;
        if (callCount < 4) {
          throw { code: "TRANSPORT_ERROR", message: "Network error" };
        }
        return { ok: true, result: { ok: true, applied: ["m1"] } };
      });

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: {
        offlinability: true,
        remote: "http://example.com",
        pushMaxRetries: 3,
        pushInterval: 1000,
        pushRetryBackoff: {
          baseDelayMs: 100,
          multiplier: 2,
          maxDelayMs: 1000,
          jitterMs: 0, // No jitter for predictable testing
        },
      },
      clientId: "c1",
      storage,
    });

    // Subscribe to events to track retries
    const eventHandler = vi.fn();
    client.subscribe(eventHandler);

    // Start sync engine
    await client.sync.start();

    // Trigger push and wait for all retries
    // Delays: 100ms, 200ms, 400ms = 700ms total + 1000ms initial interval + buffer
    await vi.advanceTimersByTimeAsync(1000); // Initial interval
    await vi.advanceTimersByTimeAsync(100);  // First retry delay
    await vi.advanceTimersByTimeAsync(200);  // Second retry delay
    await vi.advanceTimersByTimeAsync(400);  // Third retry delay
    await vi.advanceTimersByTimeAsync(100);  // Buffer for processing

    // Should have called push 4 times (1 initial + 3 retries)
    expect(pushSpy).toHaveBeenCalledTimes(4);

    // Check sync_retry events were emitted with increasing delays
    const retryEvents = eventHandler.mock.calls
      .map((call) => call[0])
      .filter((event: any) => event.type === "sync_retry");

    expect(retryEvents).toHaveLength(3);
    
    // First retry: ~100ms delay (baseDelayMs * 2^0)
    expect(retryEvents[0].context.delayMs).toBeCloseTo(100, 0);
    
    // Second retry: ~200ms delay (baseDelayMs * 2^1)
    expect(retryEvents[1].context.delayMs).toBeCloseTo(200, 0);
    
    // Third retry: ~400ms delay (baseDelayMs * 2^2)
    expect(retryEvents[2].context.delayMs).toBeCloseTo(400, 0);

    // Should eventually succeed
    const successEvent = eventHandler.mock.calls
      .map((call) => call[0])
      .find((event: any) => event.type === "sync_applied" && event.context?.phase === "push");
    expect(successEvent).toBeDefined();

    client.sync.stop();
  });

  it("TV-RET-001 (Max Delay): Max delay is capped at maxDelayMs", async () => {
    const storage = new MockStorageAdapter();
    await storage.changelogAppend({
      clientId: "c1",
      mutationId: "m1",
      timestampMs: 1,
      mutation: { resource: "task", operation: "merge", id: "t1" },
    });

    vi.spyOn(DefaultHttpTransport.prototype, "clone").mockResolvedValue({
      ok: true,
      result: { ok: true, data: {}, cursors: {} },
    });
    vi.spyOn(DefaultHttpTransport.prototype, "pull").mockResolvedValue({
      ok: true,
      result: { ok: true, records: {}, deleted: {}, cursors: {} },
    });

    let callCount = 0;
    vi.spyOn(DefaultHttpTransport.prototype, "push").mockImplementation(async () => {
      callCount++;
      if (callCount < 4) {
        throw { code: "TRANSPORT_ERROR" };
      }
      return { ok: true, result: { ok: true, applied: ["m1"] } };
    });

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: {
        offlinability: true,
        remote: "http://example.com",
        pushMaxRetries: 3,
        pushInterval: 5000,
        pushRetryBackoff: {
          baseDelayMs: 1000,
          multiplier: 2,
          maxDelayMs: 2000, // Cap at 2000ms
          jitterMs: 0,
        },
      },
      clientId: "c1",
      storage,
    });

    const eventHandler = vi.fn();
    client.subscribe(eventHandler);

    await client.sync.start();
    
    // Wait for push interval + all retry delays
    // Delays: 1000ms, 2000ms (capped), 2000ms (capped) = 5000ms + 5000ms initial = 10000ms
    await vi.advanceTimersByTimeAsync(5000);  // Initial interval
    await vi.advanceTimersByTimeAsync(1000);  // First retry delay
    await vi.advanceTimersByTimeAsync(2000);  // Second retry delay (capped)
    await vi.advanceTimersByTimeAsync(2000);  // Third retry delay (capped)
    await vi.advanceTimersByTimeAsync(100);   // Buffer

    const retryEvents = eventHandler.mock.calls
      .map((call) => call[0])
      .filter((event: any) => event.type === "sync_retry");

    expect(retryEvents).toHaveLength(3);
    
    // First retry: 1000ms
    expect(retryEvents[0].context.delayMs).toBe(1000);
    
    // Second retry: 2000ms (capped at maxDelayMs)
    expect(retryEvents[1].context.delayMs).toBe(2000);
    
    // Third retry: 2000ms (would be 4000, but capped)
    expect(retryEvents[2].context.delayMs).toBe(2000);

    client.sync.stop();
  });

  it("TV-RET-001 (Configurable): Custom backoff parameters work", async () => {
    const storage = new MockStorageAdapter();
    await storage.changelogAppend({
      clientId: "c1",
      mutationId: "m1",
      timestampMs: 1,
      mutation: { resource: "task", operation: "merge", id: "t1" },
    });

    vi.spyOn(DefaultHttpTransport.prototype, "clone").mockResolvedValue({
      ok: true,
      result: { ok: true, data: {}, cursors: {} },
    });
    vi.spyOn(DefaultHttpTransport.prototype, "pull").mockResolvedValue({
      ok: true,
      result: { ok: true, records: {}, deleted: {}, cursors: {} },
    });

    let callCount = 0;
    vi.spyOn(DefaultHttpTransport.prototype, "push").mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        throw { code: "TRANSPORT_ERROR" };
      }
      return { ok: true, result: { ok: true, applied: ["m1"] } };
    });

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: {
        offlinability: true,
        remote: "http://example.com",
        pushMaxRetries: 2,
        pushInterval: 3000,
        pushRetryBackoff: {
          baseDelayMs: 50, // Custom base
          multiplier: 3,   // Custom multiplier
          maxDelayMs: 500,
          jitterMs: 0,
        },
      },
      clientId: "c1",
      storage,
    });

    const eventHandler = vi.fn();
    client.subscribe(eventHandler);

    await client.sync.start();
    await vi.advanceTimersByTimeAsync(3100);

    const retryEvents = eventHandler.mock.calls
      .map((call) => call[0])
      .filter((event: any) => event.type === "sync_retry");

    expect(retryEvents).toHaveLength(2);
    
    // First retry: 50 * 3^0 = 50ms
    expect(retryEvents[0].context.delayMs).toBe(50);
    
    // Second retry: 50 * 3^1 = 150ms
    expect(retryEvents[1].context.delayMs).toBe(150);

    client.sync.stop();
  });

  it("TV-RET-001N: Default backoff parameters apply when not configured", async () => {
    const storage = new MockStorageAdapter();
    await storage.changelogAppend({
      clientId: "c1",
      mutationId: "m1",
      timestampMs: 1,
      mutation: { resource: "task", operation: "merge", id: "t1" },
    });

    vi.spyOn(DefaultHttpTransport.prototype, "clone").mockResolvedValue({
      ok: true,
      result: { ok: true, data: {}, cursors: {} },
    });
    vi.spyOn(DefaultHttpTransport.prototype, "pull").mockResolvedValue({
      ok: true,
      result: { ok: true, records: {}, deleted: {}, cursors: {} },
    });

    let callCount = 0;
    vi.spyOn(DefaultHttpTransport.prototype, "push").mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        throw { code: "TRANSPORT_ERROR" };
      }
      return { ok: true, result: { ok: true, applied: ["m1"] } };
    });

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: {
        offlinability: true,
        remote: "http://example.com",
        pushMaxRetries: 2,
        pushInterval: 5000,
        // No pushRetryBackoff config - should use defaults
      },
      clientId: "c1",
      storage,
    });

    const eventHandler = vi.fn();
    client.subscribe(eventHandler);

    await client.sync.start();
    
    // Wait for push interval + all retry delays with default config
    // Defaults: baseDelayMs=1000, multiplier=2, jitterMs=500
    // Delays: ~1000-1500ms, ~2000-2500ms
    await vi.advanceTimersByTimeAsync(5000);  // Initial interval
    await vi.advanceTimersByTimeAsync(1500);  // First retry delay (1000 + max jitter)
    await vi.advanceTimersByTimeAsync(2500);  // Second retry delay (2000 + max jitter)
    await vi.advanceTimersByTimeAsync(100);   // Buffer

    const retryEvents = eventHandler.mock.calls
      .map((call) => call[0])
      .filter((event: any) => event.type === "sync_retry");

    expect(retryEvents).toHaveLength(2);
    
    // Default: baseDelayMs=1000, multiplier=2, jitterMs=500
    // First retry: ~1000ms + jitter (0-500ms)
    expect(retryEvents[0].context.delayMs).toBeGreaterThanOrEqual(1000);
    expect(retryEvents[0].context.delayMs).toBeLessThanOrEqual(1500);
    
    // Second retry: ~2000ms + jitter (0-500ms)
    expect(retryEvents[1].context.delayMs).toBeGreaterThanOrEqual(2000);
    expect(retryEvents[1].context.delayMs).toBeLessThanOrEqual(2500);

    client.sync.stop();
  });

  it("TV-RET-001 (Reset): Successful push resets backoff on next call", async () => {
    const storage = new MockStorageAdapter();
    
    // First batch: will fail then succeed
    await storage.changelogAppend({
      clientId: "c1",
      mutationId: "m1",
      timestampMs: 1,
      mutation: { resource: "task", operation: "merge", id: "t1" },
    });

    vi.spyOn(DefaultHttpTransport.prototype, "clone").mockResolvedValue({
      ok: true,
      result: { ok: true, data: {}, cursors: {} },
    });
    vi.spyOn(DefaultHttpTransport.prototype, "pull").mockResolvedValue({
      ok: true,
      result: { ok: true, records: {}, deleted: {}, cursors: {} },
    });

    let callCount = 0;
    const pushSpy = vi
      .spyOn(DefaultHttpTransport.prototype, "push")
      .mockImplementation(async () => {
        callCount++;
        
        // First call: fail
        if (callCount === 1) {
          throw { code: "TRANSPORT_ERROR" };
        }
        
        // Second call (first retry): succeed
        if (callCount === 2) {
          return { ok: true, result: { ok: true, applied: ["m1"] } };
        }
        
        // Third call (new push after interval): fail
        if (callCount === 3) {
          throw { code: "TRANSPORT_ERROR" };
        }
        
        // Fourth call: succeed
        return { ok: true, result: { ok: true, applied: ["m2"] } };
      });

    const client = createDatafnClient({
      schema: defaultSchema,
      sync: {
        offlinability: true,
        remote: "http://example.com",
        pushMaxRetries: 3,
        pushInterval: 2000,
        pushRetryBackoff: {
          baseDelayMs: 100,
          multiplier: 2,
          maxDelayMs: 1000,
          jitterMs: 0,
        },
      },
      clientId: "c1",
      storage,
    });

    const eventHandler = vi.fn();
    client.subscribe(eventHandler);

    await client.sync.start();
    
    // Wait for first push cycle (fail + retry succeed)
    await vi.advanceTimersByTimeAsync(2100);
    
    // Add a second mutation to trigger another push
    await storage.changelogAppend({
      clientId: "c1",
      mutationId: "m2",
      timestampMs: 2,
      mutation: { resource: "task", operation: "merge", id: "t2" },
    });
    
    // Wait for second push cycle
    await vi.advanceTimersByTimeAsync(2100);

    const retryEvents = eventHandler.mock.calls
      .map((call) => call[0])
      .filter((event: any) => event.type === "sync_retry");

    // Should have 2 retry events total (one from each push cycle)
    expect(retryEvents).toHaveLength(2);
    
    // Both retries should use the first backoff delay (100ms) because backoff resets after success
    expect(retryEvents[0].context.delayMs).toBe(100);
    expect(retryEvents[1].context.delayMs).toBe(100); // Reset after success

    client.sync.stop();
  });
});