/**
 * Multi-Tenant / Multi-User Tests
 * Tests for auth context and storage factory functionality
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDatafnClient } from "../src/client.js";
import { IndexedDbStorageAdapter } from "../src/adapters/indexedDbStorage.js";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";
import type { AuthContext, AuthContextProvider } from "@superfunctions/auth";

const defaultSchema = {
  resources: [
    {
      name: "task",
      version: 1,
      fields: [{ name: "title", type: "string" as const, required: true }],
    },
  ],
};

describe("@datafn/client multi-tenant support", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("IndexedDbStorageAdapter.createForUser", () => {
    it("creates adapter with user-isolated database name", () => {
      // Mock indexedDB to avoid "indexedDB is not defined" error
      const mockOpen = vi.fn(() => ({ onerror: null, onsuccess: null, onupgradeneeded: null }));
      vi.stubGlobal("indexedDB", { open: mockOpen });

      const adapter = IndexedDbStorageAdapter.createForUser(
        "my-app",
        "user-123",
      );
      expect(adapter.dbName).toBe("my-app_user-123");
      expect(mockOpen).toHaveBeenCalledWith("my-app_user-123", expect.any(Number));

      vi.unstubAllGlobals();
    });

    it("creates adapter with tenant and user-isolated database name", () => {
      const mockOpen = vi.fn(() => ({ onerror: null, onsuccess: null, onupgradeneeded: null }));
      vi.stubGlobal("indexedDB", { open: mockOpen });

      const adapter = IndexedDbStorageAdapter.createForUser(
        "my-app",
        "user-123",
        "tenant-456",
      );
      expect(adapter.dbName).toBe("my-app_tenant-456_user-123");
      expect(mockOpen).toHaveBeenCalledWith("my-app_tenant-456_user-123", expect.any(Number));

      vi.unstubAllGlobals();
    });

    it("passes resources and schema to constructor", () => {
      const mockOpen = vi.fn(() => ({ onerror: null, onsuccess: null, onupgradeneeded: null }));
      vi.stubGlobal("indexedDB", { open: mockOpen });

      const resources = ["task", "project"];
      const adapter = IndexedDbStorageAdapter.createForUser(
        "my-app",
        "user-123",
        undefined,
        resources,
      );
      expect(adapter.dbName).toBe("my-app_user-123");

      vi.unstubAllGlobals();
    });
  });

  describe("DatafnClientConfig with authContext", () => {
    it("accepts direct AuthContext object with storage factory", () => {
      const mockStorageFactory = vi.fn(() => new MemoryStorageAdapter());
      const authContext: AuthContext = {
        userId: "user-123",
        tenantId: "tenant-456",
      };

      const client = createDatafnClient({
        schema: defaultSchema,
        clientId: "test-client",
        authContext,
        storage: mockStorageFactory,
      });

      expect(client).toBeDefined();
      expect(mockStorageFactory).toHaveBeenCalledWith(authContext);
    });

    it("accepts AuthContextProvider with storage factory", () => {
      const mockStorageFactory = vi.fn(() => new MemoryStorageAdapter());
      const authContext: AuthContext = {
        userId: "user-789",
      };

      const provider: AuthContextProvider = {
        getContext: () => authContext,
      };

      const client = createDatafnClient({
        schema: defaultSchema,
        clientId: "test-client",
        authContext: provider,
        storage: mockStorageFactory,
      });

      expect(client).toBeDefined();
      expect(mockStorageFactory).toHaveBeenCalledWith(authContext);
    });

    it("throws error when storage factory is used without authContext", () => {
      const mockStorageFactory = vi.fn(() => new MemoryStorageAdapter());

      expect(() => {
        createDatafnClient({
          schema: defaultSchema,
          clientId: "test-client",
          storage: mockStorageFactory,
        });
      }).toThrow("authContext is required when storage is a factory function");
    });

    it("throws error when authContext.userId is missing", () => {
      const mockStorageFactory = vi.fn(() => new MemoryStorageAdapter());
      const authContext = {
        tenantId: "tenant-456",
      } as AuthContext;

      expect(() => {
        createDatafnClient({
          schema: defaultSchema,
          clientId: "test-client",
          authContext,
          storage: mockStorageFactory,
        });
      }).toThrow("authContext.userId is required");
    });

    it("throws error when AuthContextProvider returns Promise", () => {
      const mockStorageFactory = vi.fn(() => new MemoryStorageAdapter());

      const asyncProvider: AuthContextProvider = {
        getContext: () => Promise.resolve({ userId: "user-123" }),
      };

      expect(() => {
        createDatafnClient({
          schema: defaultSchema,
          clientId: "test-client",
          authContext: asyncProvider,
          storage: mockStorageFactory,
        });
      }).toThrow("async AuthContextProvider.getContext() is not supported");
    });

    it("works with direct storage adapter (no authContext needed)", () => {
      const storage = new MemoryStorageAdapter();

      const client = createDatafnClient({
        schema: defaultSchema,
        clientId: "test-client",
        storage,
      });

      expect(client).toBeDefined();
    });

    it("works without storage (no authContext needed)", () => {
      const client = createDatafnClient({
        schema: defaultSchema,
        sync: { remote: "http://example.com" },
        clientId: "test-client",
      });

      expect(client).toBeDefined();
    });
  });

  describe("storage factory integration", () => {
    it("creates isolated storage for different users", () => {
      // Mock indexedDB
      const mockOpen = vi.fn(() => ({ onerror: null, onsuccess: null, onupgradeneeded: null }));
      vi.stubGlobal("indexedDB", { open: mockOpen });

      const createdAdapters: { dbName: string }[] = [];

      const storageFactory = (ctx: AuthContext) => {
        const adapter = IndexedDbStorageAdapter.createForUser(
          "test-app",
          ctx.userId,
          ctx.tenantId,
        );
        createdAdapters.push({ dbName: adapter.dbName });
        return new MemoryStorageAdapter(); // Use memory for testing
      };

      // Create client for user 1
      createDatafnClient({
        schema: defaultSchema,
        clientId: "test-client-1",
        authContext: { userId: "user-1" },
        storage: storageFactory,
      });

      // Create client for user 2
      createDatafnClient({
        schema: defaultSchema,
        clientId: "test-client-2",
        authContext: { userId: "user-2" },
        storage: storageFactory,
      });

      // Create client for user 3 in different tenant
      createDatafnClient({
        schema: defaultSchema,
        clientId: "test-client-3",
        authContext: { userId: "user-3", tenantId: "tenant-a" },
        storage: storageFactory,
      });

      expect(createdAdapters).toHaveLength(3);
      expect(createdAdapters[0].dbName).toBe("test-app_user-1");
      expect(createdAdapters[1].dbName).toBe("test-app_user-2");
      expect(createdAdapters[2].dbName).toBe("test-app_tenant-a_user-3");

      vi.unstubAllGlobals();
    });
  });
});
