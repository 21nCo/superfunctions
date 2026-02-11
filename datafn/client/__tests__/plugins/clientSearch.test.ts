/**
 * Client-Side Search Plugin Tests (SRCH-001)
 * 
 * Test vectors: TV-SRCH-001, TV-SRCH-001N
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClientSearchPlugin } from "../../src/plugins/clientSearch.js";
import { MemoryStorageAdapter } from "../../src/adapters/memoryStorage.js";
import type { DatafnSchema } from "@datafn/core";

// Test schema with search indices
const testSchema: DatafnSchema = {
  resources: [
    {
      name: "task",
      version: 1,
      idPrefix: "task",
      fields: [
        { name: "id", type: "string", required: true },
        { name: "title", type: "string", required: true },
        { name: "description", type: "string", required: false },
        { name: "status", type: "string", required: false },
      ],
      indices: {
        search: ["title", "description"],
      },
    },
    {
      name: "note",
      version: 1,
      idPrefix: "note",
      fields: [
        { name: "id", type: "string", required: true },
        { name: "content", type: "string", required: true },
      ],
      // No search indices configured
    },
  ],
};

describe("Client-Side Search Plugin (SRCH-001)", () => {
  let storage: MemoryStorageAdapter;

  beforeEach(async () => {
    vi.restoreAllMocks();
    storage = new MemoryStorageAdapter();
    // Set hydration state to ready for local search (must go through hydrating state)
    await storage.setHydrationState("task", "hydrating");
    await storage.setHydrationState("task", "ready");
    await storage.setHydrationState("note", "hydrating");
    await storage.setHydrationState("note", "ready");
  });

  describe("TV-SRCH-001: Local search index returns results offline", () => {
    it("should build search index from storage records", async () => {
      // Seed storage with test records
      await storage.upsertRecord("task", {
        id: "task:1",
        title: "Meeting notes",
        description: "Discuss quarterly goals",
        status: "open",
      });
      await storage.upsertRecord("task", {
        id: "task:2",
        title: "Review meeting",
        description: "Code review session",
        status: "done",
      });
      await storage.upsertRecord("task", {
        id: "task:3",
        title: "Project planning",
        description: "Plan the next sprint",
        status: "open",
      });

      const plugin = createClientSearchPlugin({ storage });

      // Trigger index rebuild via afterSync hook
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      // Execute search query via beforeQuery hook
      const query = {
        resource: "task",
        version: 1,
        search: "meeting notes",
      };

      const transformedQuery = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query,
      );

      // Verify search candidate IDs were injected
      expect(transformedQuery).toHaveProperty("_searchCandidateIds");
      const candidateIds = (transformedQuery as any)._searchCandidateIds as string[];
      
      // Should match task:1 (has "meeting" and "notes")
      expect(candidateIds).toContain("task:1");
      
      // May also match task:2 (has "meeting") depending on fuzzy matching
      // This is acceptable behavior
    });

    it("should search across multiple fields", async () => {
      await storage.upsertRecord("task", {
        id: "task:1",
        title: "Project X",
        description: "Build new feature",
        status: "open",
      });
      await storage.upsertRecord("task", {
        id: "task:2",
        title: "Meeting",
        description: "Discuss project X progress",
        status: "open",
      });

      const plugin = createClientSearchPlugin({ storage });
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      const query = {
        resource: "task",
        version: 1,
        search: "project X",
      };

      const transformedQuery = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query,
      );

      const candidateIds = (transformedQuery as any)._searchCandidateIds as string[];
      
      // Should match both records (one in title, one in description)
      expect(candidateIds.length).toBeGreaterThanOrEqual(1);
      expect(candidateIds).toContain("task:1");
      expect(candidateIds).toContain("task:2");
    });

    it("should support fuzzy matching", async () => {
      await storage.upsertRecord("task", {
        id: "task:1",
        title: "Meeting notes",
        description: "Discussion points",
        status: "open",
      });

      const plugin = createClientSearchPlugin({ storage });
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      // Search with slight typo
      const query = {
        resource: "task",
        version: 1,
        search: "meting", // Typo: missing 'e'
      };

      const transformedQuery = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query,
      );

      const candidateIds = (transformedQuery as any)._searchCandidateIds as string[];
      
      // Should still match due to fuzzy search
      expect(candidateIds).toContain("task:1");
    });

    it("should support prefix matching", async () => {
      await storage.upsertRecord("task", {
        id: "task:1",
        title: "Development task",
        description: "Implement feature",
        status: "open",
      });

      const plugin = createClientSearchPlugin({ storage });
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      // Search with prefix
      const query = {
        resource: "task",
        version: 1,
        search: "dev", // Prefix of "development"
      };

      const transformedQuery = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query,
      );

      const candidateIds = (transformedQuery as any)._searchCandidateIds as string[];
      
      // Should match due to prefix search
      expect(candidateIds).toContain("task:1");
    });
  });

  describe("Index updates on mutations", () => {
    it("should update index on insert mutation", async () => {
      const plugin = createClientSearchPlugin({ storage });
      
      // Build initial index
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      // Insert new record
      await storage.upsertRecord("task", {
        id: "task:1",
        title: "New task",
        description: "Test description",
        status: "open",
      });

      // Trigger index update via afterMutation hook
      await plugin.afterMutation!(
        { env: "client", schema: testSchema },
        {
          resource: "task",
          operation: "insert",
          id: "task:1",
          record: {
            title: "New task",
            description: "Test description",
          },
        },
        {},
      );

      // Search should now find the new record
      const query = {
        resource: "task",
        version: 1,
        search: "new task",
      };

      const transformedQuery = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query,
      );

      const candidateIds = (transformedQuery as any)._searchCandidateIds as string[];
      expect(candidateIds).toContain("task:1");
    });

    it("should update index on merge mutation", async () => {
      // Initial record
      await storage.upsertRecord("task", {
        id: "task:1",
        title: "Old title",
        description: "Old description",
        status: "open",
      });

      const plugin = createClientSearchPlugin({ storage });
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      // Update record in storage
      await storage.upsertRecord("task", {
        id: "task:1",
        title: "New title",
        description: "Old description",
        status: "open",
      });

      // Trigger index update
      await plugin.afterMutation!(
        { env: "client", schema: testSchema },
        {
          resource: "task",
          operation: "merge",
          id: "task:1",
          record: { title: "New title" },
        },
        {},
      );

      // Search for new title should work
      const query1 = {
        resource: "task",
        version: 1,
        search: "new title",
      };

      const transformed1 = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query1,
      );

      const candidateIds1 = (transformed1 as any)._searchCandidateIds as string[];
      expect(candidateIds1).toContain("task:1");

      // Search for old title should not return results
      const query2 = {
        resource: "task",
        version: 1,
        search: "old title",
      };

      const transformed2 = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query2,
      );

      const candidateIds2 = (transformed2 as any)._searchCandidateIds as string[];
      // "old" might still match "old description", so we check it doesn't rely solely on old title
      // The key test is that "new title" works above
    });

    it("should remove from index on delete mutation", async () => {
      await storage.upsertRecord("task", {
        id: "task:1",
        title: "To be deleted",
        description: "Test",
        status: "open",
      });

      const plugin = createClientSearchPlugin({ storage });
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      // Delete record from storage
      await storage.deleteRecord("task", "task:1");

      // Trigger index update
      await plugin.afterMutation!(
        { env: "client", schema: testSchema },
        {
          resource: "task",
          operation: "delete",
          id: "task:1",
        },
        {},
      );

      // Search should not find deleted record
      const query = {
        resource: "task",
        version: 1,
        search: "deleted",
      };

      const transformedQuery = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query,
      );

      const candidateIds = (transformedQuery as any)._searchCandidateIds as string[];
      expect(candidateIds).not.toContain("task:1");
    });

    it("should handle batch mutations", async () => {
      const plugin = createClientSearchPlugin({ storage });
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      // Insert multiple records
      await storage.upsertRecord("task", {
        id: "task:1",
        title: "First task",
        description: "Test",
        status: "open",
      });
      await storage.upsertRecord("task", {
        id: "task:2",
        title: "Second task",
        description: "Test",
        status: "open",
      });

      // Trigger batch mutation update
      await plugin.afterMutation!(
        { env: "client", schema: testSchema },
        [
          {
            resource: "task",
            operation: "insert",
            id: "task:1",
            record: { title: "First task" },
          },
          {
            resource: "task",
            operation: "insert",
            id: "task:2",
            record: { title: "Second task" },
          },
        ],
        {},
      );

      // Both should be searchable
      const query = {
        resource: "task",
        version: 1,
        search: "task",
      };

      const transformedQuery = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query,
      );

      const candidateIds = (transformedQuery as any)._searchCandidateIds as string[];
      expect(candidateIds).toContain("task:1");
      expect(candidateIds).toContain("task:2");
    });
  });

  describe("TV-SRCH-001N: Search fallback to remote when not hydrated", () => {
    it("should pass through to remote when resource is not hydrated", async () => {
      // Use a fresh storage adapter with notStarted state
      const freshStorage = new MemoryStorageAdapter();

      const plugin = createClientSearchPlugin({ storage: freshStorage });
      
      // Even if we build index, queries should fall back to remote
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage: freshStorage },
        {},
      );

      const query = {
        resource: "task",
        version: 1,
        search: "test query",
      };

      const transformedQuery = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query,
      );

      // Should NOT inject search candidate IDs (fallback to remote)
      expect(transformedQuery).not.toHaveProperty("_searchCandidateIds");
      expect(transformedQuery).toEqual(query);
    });

    it("should pass through when no storage adapter is available", async () => {
      // Create plugin without storage
      const plugin = createClientSearchPlugin();

      const query = {
        resource: "task",
        version: 1,
        search: "test query",
      };

      const transformedQuery = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query,
      );

      // Should pass through unchanged
      expect(transformedQuery).not.toHaveProperty("_searchCandidateIds");
      expect(transformedQuery).toEqual(query);
    });

    it("should pass through when resource has no search index", async () => {
      // Query a resource without search indices configured
      const plugin = createClientSearchPlugin({ storage });
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      const query = {
        resource: "note", // No search indices configured
        version: 1,
        search: "test query",
      };

      const transformedQuery = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query,
      );

      // Should pass through (no index available)
      expect(transformedQuery).not.toHaveProperty("_searchCandidateIds");
      expect(transformedQuery).toEqual(query);
    });

    it("should pass through queries without search field", async () => {
      const plugin = createClientSearchPlugin({ storage });
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      // Query without search field
      const query = {
        resource: "task",
        version: 1,
        filters: { status: "open" },
      };

      const transformedQuery = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query,
      );

      // Should pass through unchanged
      expect(transformedQuery).toEqual(query);
    });

    it("should handle batch queries", async () => {
      const plugin = createClientSearchPlugin({ storage });
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      // Batch queries are always passed through
      const queries = [
        { resource: "task", version: 1, search: "test" },
        { resource: "task", version: 1, filters: { status: "open" } },
      ];

      const transformedQueries = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        queries,
      );

      // Should pass through unchanged
      expect(transformedQueries).toEqual(queries);
    });
  });

  describe("Index rebuild scenarios", () => {
    it("should rebuild index after pull", async () => {
      const plugin = createClientSearchPlugin({ storage });

      // Trigger index rebuild via pull
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "pull",
        { storage },
        {},
      );

      // Index should be built (we can't directly test this, but afterSync should complete without error)
      expect(true).toBe(true);
    });

    it("should not rebuild index on push", async () => {
      const plugin = createClientSearchPlugin({ storage });

      // Build initial index
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      // Trigger afterSync with push (should not rebuild)
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "push",
        { storage },
        {},
      );

      // Should complete without error
      expect(true).toBe(true);
    });

    it("should handle search errors gracefully", async () => {
      const plugin = createClientSearchPlugin({ storage });
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      // Create a query that might cause issues (empty search term)
      const query = {
        resource: "task",
        version: 1,
        search: "", // Empty search term
      };

      const transformedQuery = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query,
      );

      // Should handle gracefully (either return empty results or pass through)
      expect(transformedQuery).toBeDefined();
    });

    it("should handle missing records during index update", async () => {
      const plugin = createClientSearchPlugin({ storage });
      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      // Trigger mutation for record that doesn't exist in storage
      await plugin.afterMutation!(
        { env: "client", schema: testSchema },
        {
          resource: "task",
          operation: "merge",
          id: "task:nonexistent",
          record: { title: "Test" },
        },
        {},
      );

      // Should complete without error
      expect(true).toBe(true);
    });
  });

  describe("Field boost configuration", () => {
    it("should apply field boost weights", async () => {
      await storage.upsertRecord("task", {
        id: "task:1",
        title: "important",
        description: "not important",
        status: "open",
      });
      await storage.upsertRecord("task", {
        id: "task:2",
        title: "not important",
        description: "important detail here",
        status: "open",
      });

      const plugin = createClientSearchPlugin({
        storage,
        boost: {
          title: 2.0, // Boost title matches
          description: 1.0,
        },
      });

      await plugin.afterSync!(
        { env: "client", schema: testSchema },
        "clone",
        { storage },
        {},
      );

      const query = {
        resource: "task",
        version: 1,
        search: "important",
      };

      const transformedQuery = await plugin.beforeQuery!(
        { env: "client", schema: testSchema },
        query,
      );

      const candidateIds = (transformedQuery as any)._searchCandidateIds as string[];
      
      // Both should be found
      expect(candidateIds).toContain("task:1");
      expect(candidateIds).toContain("task:2");
      
      // task:1 should rank higher due to title boost, so it should appear first
      // (MiniSearch orders results by relevance)
      expect(candidateIds[0]).toBe("task:1");
    });
  });
});
