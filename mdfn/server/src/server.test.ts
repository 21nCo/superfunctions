import { describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters/memory";
import { createMdfnService } from "./index";

describe("mdfn server", () => {
  it("wraps the adapter and enforces optimistic versions", async () => {
    const database = memoryAdapter();
    const service = createMdfnService({ database, authorize: () => true, createId: (() => { let id = 0; return () => `id-${id++}`; })() });
    const principal = { id: "u" };
    const created = await service.create(principal, { markdown: "# One" });
    const updated = await service.update(principal, created.id, { expectedVersion: 1, markdown: "# Two" });
    expect(updated.version).toBe(2);
    await expect(service.update(principal, created.id, { expectedVersion: 1, markdown: "# Three" })).rejects.toMatchObject({ code: "MDFN_VERSION_CONFLICT" });
    expect(await service.versions(principal, created.id)).toHaveLength(2);
  });

  it("enforces tenant scope before host authorization and collaboration limits", async () => {
    const database = memoryAdapter();
    const service = createMdfnService({ database, authorize: () => true, maxCollaborationUpdateBytes: 4, createId: (() => { let id = 0; return () => `tenant-id-${id++}`; })() });
    const created = await service.create({ id: "a", tenantId: "tenant-a" }, { markdown: "# Scoped" });
    await expect(service.read({ id: "b", tenantId: "tenant-b" }, created.id)).rejects.toMatchObject({ code: "MDFN_DOCUMENT_NOT_FOUND" });
    await expect(service.appendCollaborationUpdate({ id: "a", tenantId: "tenant-a" }, created.id, "12345")).rejects.toMatchObject({ code: "MDFN_COLLAB_UPDATE_TOO_LARGE", status: 413 });
  });
});
