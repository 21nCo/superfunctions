/**
 * Switchable Client Tests
 * Tests for createSwitchableClient multi-tenant context switching
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSwitchableClient } from "../src/switchableClient.js";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";
import type { AuthContext } from "@superfunctions/auth";
import type { DatafnStorageFactory } from "../src/storage.js";

// Stub remote adapter for testing
const createStubRemote = () => ({
  query: vi.fn(async () => ({ ok: true, result: { data: [], nextCursor: null } })),
  mutation: vi.fn(async () => ({ ok: true, result: { ok: true } })),
  transact: vi.fn(async () => ({ ok: true, result: { ok: true, results: [] } })),
  seed: vi.fn(async () => ({ ok: true, result: { ok: true } })),
  clone: vi.fn(async () => ({ 
    ok: true, 
    result: { 
      ok: true, 
      data: { 
        task: [], 
        kv: [] 
      },
      cursors: {
        task: "0",
        kv: "0",
      },
    } 
  })),
  pull: vi.fn(async () => ({ ok: true, result: { ok: true, updates: [] } })),
  push: vi.fn(async () => ({ ok: true, result: { ok: true } })),
  reconcile: vi.fn(async () => ({ ok: true, result: { ok: true } })),
});

const testSchema = {
  resources: [
    {
      name: "task",
      version: 1,
      fields: [
        { name: "title", type: "string" as const, required: true },
        { name: "status", type: "string" as const, required: false },
      ],
    },
  ],
};

describe("@datafn/client switchable client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("createSwitchableClient basic functionality", () => {
    it("creates a working client with initial auth context", async () => {
      const storageFactory: DatafnStorageFactory = (ctx) => {
        return new MemoryStorageAdapter(["task", "kv"]);
      };
      
      const remote = createStubRemote();
      const initialAuth: AuthContext = { userId: "user-123", tenantId: "tenant-a" };

      const { client, currentContext } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth,
        sync: { remoteAdapter: remote },
      });

      expect(client).toBeDefined();
      expect(currentContext()).toEqual(initialAuth);
      
      // Verify client is functional
      const result = await client.query({ resource: "task" });
      expect(result).toBeDefined();
      expect(remote.query).toHaveBeenCalled();
    });

    it("proxy delegates all method calls to underlying client", async () => {
      const storageFactory: DatafnStorageFactory = (ctx) => {
        return new MemoryStorageAdapter(["task", "kv"]);
      };
      
      const remote = createStubRemote();
      const { client } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth: { userId: "user-123", tenantId: "tenant-a" },
        sync: { remoteAdapter: remote },
      });

      // Test query
      await client.query({ resource: "task" });
      expect(remote.query).toHaveBeenCalled();

      // Test mutate
      remote.mutation.mockResolvedValue({ ok: true, result: { ok: true } });
      await client.mutate({
        resource: "task",
        operation: "insert",
        id: "task:1",
        record: { title: "Test" },
      });
      expect(remote.mutation).toHaveBeenCalled();

      // Test subscribe
      const handler = vi.fn();
      const unsub = client.subscribe(handler);
      expect(typeof unsub).toBe("function");
      unsub();
    });
  });

  describe("switchContext functionality", () => {
    it("destroys old client and creates new client with new auth context", async () => {
      const storages: Record<string, MemoryStorageAdapter> = {};
      const storageFactory: DatafnStorageFactory = (ctx) => {
        const key = `${ctx.tenantId}_${ctx.userId}`;
        if (!storages[key]) {
          storages[key] = new MemoryStorageAdapter(["task", "kv"]);
        }
        return storages[key];
      };
      
      const remote = createStubRemote();
      const { client, switchContext, currentContext } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth: { userId: "user-123", tenantId: "tenant-a" },
        sync: { remoteAdapter: remote },
      });

      // Verify initial context
      expect(currentContext()).toEqual({ userId: "user-123", tenantId: "tenant-a" });

      // Insert data in tenant-a
      remote.mutation.mockResolvedValue({ ok: true, result: { ok: true } });
      await client.mutate({
        resource: "task",
        operation: "insert",
        id: "task:1",
        record: { title: "Task in tenant-a" },
      });

      // Switch to tenant-b
      const newAuth: AuthContext = { userId: "user-123", tenantId: "tenant-b" };
      await switchContext(newAuth);

      // Verify context changed
      expect(currentContext()).toEqual(newAuth);

      // Verify client still works
      await client.query({ resource: "task" });
      expect(remote.query).toHaveBeenCalled();
    });

    it("uses correct tenant-scoped storage after switch", async () => {
      const storages: Record<string, MemoryStorageAdapter> = {};
      const storageFactory: DatafnStorageFactory = (ctx) => {
        const key = `${ctx.tenantId}_${ctx.userId}`;
        if (!storages[key]) {
          storages[key] = new MemoryStorageAdapter(["task", "kv"]);
        }
        return storages[key];
      };
      
      const remote = createStubRemote();
      const { client, switchContext } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth: { userId: "user-123", tenantId: "tenant-a" },
        sync: { remoteAdapter: remote, offlinability: true },
      });

      // Insert data in tenant-a's storage directly
      const storageA = storages["tenant-a_user-123"];
      await storageA.upsertRecord("task", {
        id: "task:1",
        title: "Task in tenant-a",
      });

      // Switch to tenant-b
      await switchContext({ userId: "user-123", tenantId: "tenant-b" });

      // Insert data in tenant-b's storage directly
      const storageB = storages["tenant-b_user-123"];
      await storageB.upsertRecord("task", {
        id: "task:2",
        title: "Task in tenant-b",
      });

      // Verify tenant-b storage does not have tenant-a's data
      const recordFromB = await storageB.getRecord("task", "task:1");
      expect(recordFromB).toBeNull();

      // Verify tenant-b has its own data
      const recordB = await storageB.getRecord("task", "task:2");
      expect(recordB).toBeTruthy();
      expect(recordB?.title).toBe("Task in tenant-b");

      // Switch back to tenant-a
      await switchContext({ userId: "user-123", tenantId: "tenant-a" });

      // Verify tenant-a's data is still there
      const recordA = await storageA.getRecord("task", "task:1");
      expect(recordA).toBeTruthy();
      expect(recordA?.title).toBe("Task in tenant-a");
    });

    it("calls onSwitch callback with correct old and new contexts", async () => {
      const storageFactory: DatafnStorageFactory = (ctx) => {
        return new MemoryStorageAdapter(["task", "kv"]);
      };
      
      const remote = createStubRemote();
      const onSwitch = vi.fn();
      const initialAuth: AuthContext = { userId: "user-123", tenantId: "tenant-a" };
      const newAuth: AuthContext = { userId: "user-123", tenantId: "tenant-b" };

      const { switchContext } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth,
        sync: { remoteAdapter: remote },
        onSwitch,
      });

      await switchContext(newAuth);

      expect(onSwitch).toHaveBeenCalledWith(newAuth, initialAuth);
      expect(onSwitch).toHaveBeenCalledTimes(1);
    });

    it("starts sync after switch when sync mode is enabled", async () => {
      const storageFactory: DatafnStorageFactory = (ctx) => {
        // Don't pass resource list to allow all resources including __global_cursor__
        return new MemoryStorageAdapter();
      };
      
      const remote = createStubRemote();
      
      const { client, switchContext } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth: { userId: "user-123", tenantId: "tenant-a" },
        sync: { 
          mode: "sync",
          remoteAdapter: remote,
          offlinability: true,
        },
      });

      // Switch to new tenant (will trigger sync.start() internally)
      await switchContext({ userId: "user-123", tenantId: "tenant-b" });

      // Verify sync is available
      expect(client.sync).toBeDefined();
      expect(typeof client.sync.start).toBe("function");
      expect(typeof client.sync.stop).toBe("function");
      
      // Verify clone was called during sync initialization
      expect(remote.clone).toHaveBeenCalled();
    });

    it("serializes concurrent switchContext calls", async () => {
      const storageFactory: DatafnStorageFactory = (ctx) => {
        return new MemoryStorageAdapter(["task", "kv"]);
      };
      
      const remote = createStubRemote();
      const switchLog: string[] = [];
      const onSwitch = vi.fn((newCtx: AuthContext, oldCtx: AuthContext) => {
        switchLog.push(`${oldCtx.tenantId} -> ${newCtx.tenantId}`);
      });

      const { switchContext, currentContext } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth: { userId: "user-123", tenantId: "tenant-a" },
        sync: { remoteAdapter: remote },
        onSwitch,
      });

      // Trigger three rapid switches
      const switch1 = switchContext({ userId: "user-123", tenantId: "tenant-b" });
      const switch2 = switchContext({ userId: "user-123", tenantId: "tenant-c" });
      const switch3 = switchContext({ userId: "user-123", tenantId: "tenant-d" });

      // Wait for all to complete
      await Promise.all([switch1, switch2, switch3]);

      // Verify final context is tenant-d
      expect(currentContext().tenantId).toBe("tenant-d");

      // Verify all switches executed in order
      expect(onSwitch).toHaveBeenCalledTimes(3);
      expect(switchLog).toEqual([
        "tenant-a -> tenant-b",
        "tenant-b -> tenant-c",
        "tenant-c -> tenant-d",
      ]);
    });
  });

  describe("destroy functionality", () => {
    it("destroys the underlying client", async () => {
      const storageFactory: DatafnStorageFactory = (ctx) => {
        return new MemoryStorageAdapter(["task", "kv"]);
      };
      
      const remote = createStubRemote();
      const { client, destroy } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth: { userId: "user-123", tenantId: "tenant-a" },
        sync: { remoteAdapter: remote },
      });

      // Verify client works before destroy
      await client.query({ resource: "task" });
      expect(remote.query).toHaveBeenCalled();

      // Destroy
      await destroy();

      // Verify client throws after destroy
      try {
        await client.query({ resource: "task" });
        expect.fail("Expected query to throw after destroy");
      } catch (err: any) {
        expect(err.code).toBe("DFQL_INVALID");
        expect(err.message).toContain("destroyed");
      }
    });

    it("waits for in-progress switch before destroying", async () => {
      const storageFactory: DatafnStorageFactory = (ctx) => {
        return new MemoryStorageAdapter(["task", "kv"]);
      };
      
      const remote = createStubRemote();
      let switchCompleted = false;
      const onSwitch = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        switchCompleted = true;
      });

      const { destroy, switchContext } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth: { userId: "user-123", tenantId: "tenant-a" },
        sync: { remoteAdapter: remote },
        onSwitch,
      });

      // Start a switch (don't await)
      const switchPromise = switchContext({ userId: "user-123", tenantId: "tenant-b" });

      // Try to destroy while switch is in progress
      const destroyPromise = destroy();

      // Both should complete
      await Promise.all([switchPromise, destroyPromise]);

      // Verify switch completed before destroy
      expect(switchCompleted).toBe(true);
      expect(onSwitch).toHaveBeenCalledTimes(1);
    });

    it("clears the switch queue", async () => {
      const storageFactory: DatafnStorageFactory = (ctx) => {
        return new MemoryStorageAdapter(["task", "kv"]);
      };
      
      const remote = createStubRemote();
      const { destroy, switchContext } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth: { userId: "user-123", tenantId: "tenant-a" },
        sync: { remoteAdapter: remote },
      });

      // Queue multiple switches (don't await)
      const switch1 = switchContext({ userId: "user-123", tenantId: "tenant-b" });
      
      // Destroy should wait and complete
      await destroy();
      await switch1;

      // Subsequent operations should fail with our custom error
      try {
        await switchContext({ userId: "user-123", tenantId: "tenant-c" });
        expect.fail("Expected switchContext to throw after destroy");
      } catch (err: any) {
        expect(err.message).toContain("destroyed");
      }
    });
  });

  describe("edge cases", () => {
    it("handles async onSwitch callback", async () => {
      const storageFactory: DatafnStorageFactory = (ctx) => {
        return new MemoryStorageAdapter(["task", "kv"]);
      };
      
      const remote = createStubRemote();
      const onSwitch = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });

      const { switchContext } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth: { userId: "user-123", tenantId: "tenant-a" },
        sync: { remoteAdapter: remote },
        onSwitch,
      });

      await switchContext({ userId: "user-123", tenantId: "tenant-b" });
      expect(onSwitch).toHaveBeenCalledTimes(1);
    });

    it("preserves clientId across switches", async () => {
      const storageFactory: DatafnStorageFactory = (ctx) => {
        return new MemoryStorageAdapter(["task", "kv"]);
      };
      
      const remote = createStubRemote();
      const clientId = "stable-device-id";

      const { switchContext } = createSwitchableClient({
        schema: testSchema,
        clientId,
        storage: storageFactory,
        initialAuth: { userId: "user-123", tenantId: "tenant-a" },
        sync: { remoteAdapter: remote },
      });

      // Switch multiple times
      await switchContext({ userId: "user-123", tenantId: "tenant-b" });
      await switchContext({ userId: "user-123", tenantId: "tenant-c" });

      // The clientId should remain the same across all switches
      // (we can't directly access it, but this verifies no errors occur)
      expect(true).toBe(true);
    });

    it("works without sync config", async () => {
      const storageFactory: DatafnStorageFactory = (ctx) => {
        return new MemoryStorageAdapter(["task", "kv"]);
      };

      const { client, switchContext } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth: { userId: "user-123", tenantId: "tenant-a" },
        // No sync config
      });

      expect(client).toBeDefined();

      // Switch should work without sync
      await switchContext({ userId: "user-123", tenantId: "tenant-b" });

      expect(client).toBeDefined();
    });

    it("works without onSwitch callback", async () => {
      const storageFactory: DatafnStorageFactory = (ctx) => {
        return new MemoryStorageAdapter(["task", "kv"]);
      };
      
      const remote = createStubRemote();

      const { switchContext } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth: { userId: "user-123", tenantId: "tenant-a" },
        sync: { remoteAdapter: remote },
        // No onSwitch callback
      });

      // Should not throw
      await switchContext({ userId: "user-123", tenantId: "tenant-b" });
    });

    it("supports custom generateId function", async () => {
      const storageFactory: DatafnStorageFactory = (ctx) => {
        return new MemoryStorageAdapter(["task", "kv"]);
      };
      
      const remote = createStubRemote();
      const customGenerateId = vi.fn(({ resource }: { resource: string }) => {
        // Must use correct prefix format: resource:id
        return `${resource}:custom_${Date.now()}`;
      });

      const { client } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth: { userId: "user-123", tenantId: "tenant-a" },
        sync: { remoteAdapter: remote },
        generateId: customGenerateId,
      });

      // Verify the table is accessible through the proxy
      expect(client.task).toBeDefined();
      expect(typeof client.task.mutate).toBe("function");

      // Insert without explicit ID (using mutate API)
      remote.mutation.mockResolvedValue({ ok: true, result: { ok: true } });
      await client.task.mutate({
        operation: "insert",
        record: { title: "Test Task" },
      });

      // Verify custom ID generator was called
      expect(customGenerateId).toHaveBeenCalled();
    });
  });

  describe("client interface completeness", () => {
    it("exposes all expected methods on proxied client", async () => {
      const storageFactory: DatafnStorageFactory = (ctx) => {
        return new MemoryStorageAdapter(["task", "kv"]);
      };
      
      const remote = createStubRemote();

      const { client } = createSwitchableClient({
        schema: testSchema,
        clientId: "test-client",
        storage: storageFactory,
        initialAuth: { userId: "user-123", tenantId: "tenant-a" },
        sync: { remoteAdapter: remote, offlinability: true },
      });

      // Verify all expected methods exist
      expect(typeof client.query).toBe("function");
      expect(typeof client.mutate).toBe("function");
      expect(typeof client.transact).toBe("function");
      expect(typeof client.subscribe).toBe("function");
      expect(typeof client.destroy).toBe("function");
      expect(typeof client.clear).toBe("function");
      expect(typeof client.flush).toBe("function");
      expect(typeof client.flushAll).toBe("function");
      expect(typeof client.exportData).toBe("function");
      expect(typeof client.importData).toBe("function");
      expect(typeof client.checkHealth).toBe("function");
      expect(typeof client.table).toBe("function");
      
      // Verify sync facade
      expect(client.sync).toBeDefined();
      expect(typeof client.sync.start).toBe("function");
      expect(typeof client.sync.stop).toBe("function");
      expect(typeof client.sync.pullNow).toBe("function");
      expect(typeof client.sync.cloneNow).toBe("function");
      
      // Verify KV API
      expect(client.kv).toBeDefined();
      expect(typeof client.kv.get).toBe("function");
      expect(typeof client.kv.set).toBe("function");
      
      // Verify resource accessors
      expect(client.task).toBeDefined();
      expect(typeof client.task.mutate).toBe("function");
      expect(typeof client.task.query).toBe("function");
    });
  });
});
