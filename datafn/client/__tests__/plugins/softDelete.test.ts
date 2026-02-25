/**
 * Soft-Delete Plugin Tests (SD-001)
 * 
 * Test vectors: TV-SD-001, TV-SD-001N
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDatafnClient } from "../../src/client.js";
import { DefaultHttpTransport } from "../../src/transport/http.js";
import { createSoftDeletePlugin, restore } from "../../src/plugins/softDelete.js";
import type { DatafnSchema } from "@datafn/core";

// Test schema with soft-delete fields
const testSchema: DatafnSchema = {
  resources: [
    {
      name: "task",
      version: 1,
      idPrefix: "task",
      fields: [
        { name: "id", type: "string", required: true },
        { name: "title", type: "string", required: true },
        { name: "status", type: "string", required: false },
        { name: "isDeleted", type: "boolean", required: false },
        { name: "deletedAt", type: "date", required: false, nullable: true },
      ],
    },
    {
      name: "note",
      version: 1,
      idPrefix: "note",
      fields: [
        { name: "id", type: "string", required: true },
        { name: "content", type: "string", required: true },
        // No soft-delete fields (not configured for soft-delete)
      ],
    },
  ],
};

describe("Soft-Delete Plugin (SD-001)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("TV-SD-001: Delete mutation converted to merge with isDeleted flag", () => {
    it("should convert delete to merge with isDeleted=true and deletedAt", async () => {
      const mutationCalls: unknown[] = [];

      vi.spyOn(DefaultHttpTransport.prototype, "mutation").mockImplementation(
        async (m: unknown) => {
          mutationCalls.push(m);
          return {
            ok: true,
            result: {
              ok: true,
              mutationId: "m-1",
              affectedIds: ["task:1"],
              errors: [],
              deduped: false,
            },
          };
        },
      );

      const client = createDatafnClient({
        clientId: "client:1",
        schema: testSchema,
        sync: { remote: "http://localhost:3000/datafn" },
        plugins: [
          createSoftDeletePlugin({
            resources: ["task"],
          }),
        ],
      });

      const table = client.table("task");
      
      // Attempt to delete - should be converted to merge
      await table.mutate({
        operation: "delete",
        id: "task:1",
      });

      // Verify the request was transformed to a merge
      expect(mutationCalls).toHaveLength(1);
      const requestBody = mutationCalls[0] as Record<string, unknown>;
      expect(requestBody.operation).toBe("merge");
      expect(requestBody.record).toMatchObject({
        isDeleted: true,
        deletedAt: expect.any(Number), // Date serialized to epoch milliseconds by date codec
      });
      
      // Verify deletedAt is a valid epoch timestamp
      const record = requestBody.record as Record<string, unknown>;
      const deletedAt = record.deletedAt as number;
      expect(typeof deletedAt).toBe("number");
      expect(deletedAt).toBeLessThanOrEqual(Date.now());
    });

    it("should use custom field names when configured", async () => {
      const mutationCalls: unknown[] = [];

      vi.spyOn(DefaultHttpTransport.prototype, "mutation").mockImplementation(
        async (m: unknown) => {
          mutationCalls.push(m);
          return {
            ok: true,
            result: {
              ok: true,
              mutationId: "m-1",
              affectedIds: ["task:1"],
              errors: [],
              deduped: false,
            },
          };
        },
      );

      const client = createDatafnClient({
        clientId: "client:1",
        schema: testSchema,
        sync: { remote: "http://localhost:3000/datafn" },
        plugins: [
          createSoftDeletePlugin({
            resources: ["task"],
            deletedAtField: "removedAt",
            isDeletedField: "archived",
          }),
        ],
      });

      const table = client.table("task");
      await table.mutate({
        operation: "delete",
        id: "task:1",
      });

      const requestBody = mutationCalls[0] as Record<string, unknown>;
      const record = requestBody.record as Record<string, unknown>;
      expect(record.archived).toBe(true);
      expect(record.removedAt).toBeTruthy(); // Can be Date or string depending on codec
      // Verify it's a valid date (parse if string, check if Date)
      const removedAt = typeof record.removedAt === 'string' ? new Date(record.removedAt) : record.removedAt;
      expect(removedAt).toBeInstanceOf(Date);
    });

    it("should work with batch mutations", async () => {
      const mutationCalls: unknown[] = [];

      vi.spyOn(DefaultHttpTransport.prototype, "mutation").mockImplementation(
        async (m: unknown) => {
          mutationCalls.push(m);
          // Return batch result for batch mutation - array of individual results
          if (Array.isArray(m)) {
            return {
              ok: true,
              result: m.map((_, i) => ({
                ok: true,
                mutationId: `m-${i + 1}`,
                affectedIds: [`task:${i + 1}`],
                errors: [],
                deduped: false,
              })),
            };
          }
          return {
            ok: true,
            result: {
              ok: true,
              mutationId: "m-1",
              affectedIds: ["task:1"],
              errors: [],
              deduped: false,
            },
          };
        },
      );

      const client = createDatafnClient({
        clientId: "client:1",
        schema: testSchema,
        sync: { remote: "http://localhost:3000/datafn" },
        plugins: [
          createSoftDeletePlugin({
            resources: ["task"],
          }),
        ],
      });

      const table = client.table("task");
      await table.mutate([
        { operation: "delete", id: "task:1" },
        { operation: "delete", id: "task:2" },
      ]);

      const requestBody = mutationCalls[0];
      expect(Array.isArray(requestBody)).toBe(true);
      const mutations = requestBody as Array<Record<string, unknown>>;
      expect(mutations).toHaveLength(2);
      expect(mutations[0].operation).toBe("merge");
      expect(mutations[1].operation).toBe("merge");
    });
  });

  describe("TV-SD-001N: Query excludes soft-deleted records", () => {
    it("should auto-filter soft-deleted records from queries", async () => {
      const queryCalls: unknown[] = [];

      vi.spyOn(DefaultHttpTransport.prototype, "query").mockImplementation(
        async (q: unknown) => {
          queryCalls.push(q);
          return {
            ok: true,
            result: {
              data: [{ id: "task:1", title: "Active Task", isDeleted: false }],
              nextCursor: null,
            },
          };
        },
      );

      const client = createDatafnClient({
        clientId: "client:1",
        schema: testSchema,
        sync: { remote: "http://localhost:3000/datafn" },
        plugins: [
          createSoftDeletePlugin({
            resources: ["task"],
          }),
        ],
      });

      const table = client.table("task");
      await table.query({});

      // Verify the filter was injected
      const requestBody = queryCalls[0] as Record<string, unknown>;
      expect(requestBody.filters).toMatchObject({
        isDeleted: { $ne: true },
      });
    });

    it("should merge with existing filters using $and", async () => {
      const queryCalls: unknown[] = [];

      vi.spyOn(DefaultHttpTransport.prototype, "query").mockImplementation(
        async (q: unknown) => {
          queryCalls.push(q);
          return {
            ok: true,
            result: {
              data: [],
              nextCursor: null,
            },
          };
        },
      );

      const client = createDatafnClient({
        clientId: "client:1",
        schema: testSchema,
        sync: { remote: "http://localhost:3000/datafn" },
        plugins: [
          createSoftDeletePlugin({
            resources: ["task"],
          }),
        ],
      });

      const table = client.table("task");
      await table.query({
        filters: { status: "open" },
      });

      const requestBody = queryCalls[0] as Record<string, unknown>;
      expect(requestBody.filters).toMatchObject({
        $and: [
          { status: "open" },
          { isDeleted: { $ne: true } },
        ],
      });
    });

    it("should extend existing $and filters", async () => {
      const queryCalls: unknown[] = [];

      vi.spyOn(DefaultHttpTransport.prototype, "query").mockImplementation(
        async (q: unknown) => {
          queryCalls.push(q);
          return {
            ok: true,
            result: {
              data: [],
              nextCursor: null,
            },
          };
        },
      );

      const client = createDatafnClient({
        clientId: "client:1",
        schema: testSchema,
        sync: { remote: "http://localhost:3000/datafn" },
        plugins: [
          createSoftDeletePlugin({
            resources: ["task"],
          }),
        ],
      });

      const table = client.table("task");
      await table.query({
        filters: {
          $and: [
            { status: "open" },
            { title: { $like: "Test%" } },
          ],
        },
      });

      const requestBody = queryCalls[0] as Record<string, unknown>;
      expect(requestBody.filters).toMatchObject({
        $and: [
          { status: "open" },
          { title: { $like: "Test%" } },
          { isDeleted: { $ne: true } },
        ],
      });
    });

    it("should allow includeDeleted metadata to bypass filter", async () => {
      const queryCalls: unknown[] = [];

      vi.spyOn(DefaultHttpTransport.prototype, "query").mockImplementation(
        async (q: unknown) => {
          queryCalls.push(q);
          return {
            ok: true,
            result: {
              data: [
                { id: "task:1", title: "Active", isDeleted: false },
                { id: "task:2", title: "Deleted", isDeleted: true },
              ],
              nextCursor: null,
            },
          };
        },
      );

      const client = createDatafnClient({
        clientId: "client:1",
        schema: testSchema,
        sync: { remote: "http://localhost:3000/datafn" },
        plugins: [
          createSoftDeletePlugin({
            resources: ["task"],
          }),
        ],
      });

      const table = client.table("task");
      await table.query({
        metadata: { includeDeleted: true },
      });

      // Verify NO filter was injected
      const requestBody = queryCalls[0] as Record<string, unknown>;
      expect(requestBody.filters).toBeUndefined();
    });

    it("should not affect non-configured resources", async () => {
      const queryCalls: unknown[] = [];
      const mutationCalls: unknown[] = [];

      vi.spyOn(DefaultHttpTransport.prototype, "query").mockImplementation(
        async (q: unknown) => {
          queryCalls.push(q);
          return {
            ok: true,
            result: {
              data: [],
              nextCursor: null,
            },
          };
        },
      );

      vi.spyOn(DefaultHttpTransport.prototype, "mutation").mockImplementation(
        async (m: unknown) => {
          mutationCalls.push(m);
          return {
            ok: true,
            result: {
              ok: true,
              mutationId: "m-1",
              affectedIds: ["note:1"],
              errors: [],
              deduped: false,
            },
          };
        },
      );

      const client = createDatafnClient({
        clientId: "client:1",
        schema: testSchema,
        sync: { remote: "http://localhost:3000/datafn" },
        plugins: [
          createSoftDeletePlugin({
            resources: ["task"], // note is NOT configured
          }),
        ],
      });

      const table = client.table("note");
      
      // Delete on non-configured resource should NOT be converted
      await table.mutate({
        operation: "delete",
        id: "note:1",
      });

      const deleteRequestBody = mutationCalls[0] as Record<string, unknown>;
      expect(deleteRequestBody.operation).toBe("delete");
      expect(deleteRequestBody.record).toBeUndefined();

      // Query on non-configured resource should NOT have filter
      await table.query({});

      const queryRequestBody = queryCalls[0] as Record<string, unknown>;
      expect(queryRequestBody.filters).toBeUndefined();
    });

    it("should work with batch queries", async () => {
      const queryCalls: unknown[] = [];

      vi.spyOn(DefaultHttpTransport.prototype, "query").mockImplementation(
        async (q: unknown) => {
          queryCalls.push(q);
          return {
            ok: true,
            result: [
              { data: [], nextCursor: null },
              { data: [], nextCursor: null },
            ],
          };
        },
      );

      const client = createDatafnClient({
        clientId: "client:1",
        schema: testSchema,
        sync: { remote: "http://localhost:3000/datafn" },
        plugins: [
          createSoftDeletePlugin({
            resources: ["task"],
          }),
        ],
      });

      await client.query([
        { resource: "task", version: 1 },
        { resource: "task", version: 1, filters: { status: "open" } },
      ]);

      const requestBody = queryCalls[0];
      expect(Array.isArray(requestBody)).toBe(true);
      const queries = requestBody as Array<Record<string, unknown>>;
      expect(queries).toHaveLength(2);
      
      // First query should have soft-delete filter only
      expect(queries[0].filters).toMatchObject({
        isDeleted: { $ne: true },
      });
      
      // Second query should merge filters
      expect(queries[1].filters).toMatchObject({
        $and: [
          { status: "open" },
          { isDeleted: { $ne: true } },
        ],
      });
    });
  });

  describe("Restore utility function", () => {
    it("should restore a soft-deleted record", async () => {
      const mutationCalls: unknown[] = [];

      vi.spyOn(DefaultHttpTransport.prototype, "mutation").mockImplementation(
        async (m: unknown) => {
          mutationCalls.push(m);
          return {
            ok: true,
            result: {
              ok: true,
              mutationId: "m-1",
              affectedIds: ["task:1"],
              errors: [],
              deduped: false,
            },
          };
        },
      );

      const client = createDatafnClient({
        clientId: "client:1",
        schema: testSchema,
        sync: { remote: "http://localhost:3000/datafn" },
      });

      const table = client.table("task");
      await restore(table, "task:1");

      const requestBody = mutationCalls[0] as Record<string, unknown>;
      expect(requestBody.operation).toBe("merge");
      expect(requestBody.id).toBe("task:1");
      expect(requestBody.record).toMatchObject({
        isDeleted: false,
        deletedAt: null,
      });
    });

    it("should support custom field names", async () => {
      const mutationCalls: unknown[] = [];

      vi.spyOn(DefaultHttpTransport.prototype, "mutation").mockImplementation(
        async (m: unknown) => {
          mutationCalls.push(m);
          return {
            ok: true,
            result: {
              ok: true,
              mutationId: "m-1",
              affectedIds: ["task:1"],
              errors: [],
              deduped: false,
            },
          };
        },
      );

      const client = createDatafnClient({
        clientId: "client:1",
        schema: testSchema,
        sync: { remote: "http://localhost:3000/datafn" },
      });

      const table = client.table("task");
      await restore(table, "task:1", {
        deletedAtField: "removedAt",
        isDeletedField: "archived",
      });

      const requestBody = mutationCalls[0] as Record<string, unknown>;
      expect(requestBody.record).toMatchObject({
        archived: false,
        removedAt: null,
      });
    });
  });

  describe("Plugin configuration edge cases", () => {
    it("should handle empty resource list", async () => {
      const mutationCalls: unknown[] = [];

      vi.spyOn(DefaultHttpTransport.prototype, "mutation").mockImplementation(
        async (m: unknown) => {
          mutationCalls.push(m);
          return {
            ok: true,
            result: {
              ok: true,
              mutationId: "m-1",
              affectedIds: ["task:1"],
              errors: [],
              deduped: false,
            },
          };
        },
      );

      const client = createDatafnClient({
        clientId: "client:1",
        schema: testSchema,
        sync: { remote: "http://localhost:3000/datafn" },
        plugins: [
          createSoftDeletePlugin({
            resources: [], // Empty list
          }),
        ],
      });

      const table = client.table("task");
      await table.mutate({
        operation: "delete",
        id: "task:1",
      });

      // Should NOT convert delete (no resources configured)
      const requestBody = mutationCalls[0] as Record<string, unknown>;
      expect(requestBody.operation).toBe("delete");
    });

    it("should handle non-delete operations normally", async () => {
      const mutationCalls: unknown[] = [];

      vi.spyOn(DefaultHttpTransport.prototype, "mutation").mockImplementation(
        async (m: unknown) => {
          mutationCalls.push(m);
          return {
            ok: true,
            result: {
              ok: true,
              mutationId: "m-1",
              affectedIds: ["task:1"],
              errors: [],
              deduped: false,
            },
          };
        },
      );

      const client = createDatafnClient({
        clientId: "client:1",
        schema: testSchema,
        sync: { remote: "http://localhost:3000/datafn" },
        plugins: [
          createSoftDeletePlugin({
            resources: ["task"],
          }),
        ],
      });

      const table = client.table("task");
      await table.mutate({
        operation: "merge",
        id: "task:1",
        record: { title: "Updated" },
      });

      // Should pass through unchanged
      const requestBody = mutationCalls[0] as Record<string, unknown>;
      expect(requestBody.operation).toBe("merge");
      expect(requestBody.record).toMatchObject({ title: "Updated" });
    });
  });
});
