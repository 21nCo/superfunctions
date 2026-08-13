import { describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/testing";
import { CatchFnService } from "@catchfn/server";
import { catchFnAdminCapability, createCatchFnAdminAdapter, createCatchFnAdminService } from "../index.js";

const scope = { organizationId: "org_1", workspaceId: "workspace_1", projectId: "project_1", environmentId: "env_1", namespace: "tenant_1" };
const context = { scope, actor: { id: "operator_1" }, requestId: "request_1", source: "console" as const };

describe("@catchfn/admin", () => {
  it("persists, reads, and lists bug reports through CatchFnService", async () => {
    const service = createCatchFnAdminService(new CatchFnService({ db: memoryAdapter({ debug: false }) }), scope);
    const adapter = createCatchFnAdminAdapter(service);
    const report = { id: "bug_1", timestamp: 2, title: "Checkout failed", severity: "high" as const };
    await expect(adapter.invoke("catchfn.bug-reports.create", report, context)).resolves.toMatchObject({ data: { item: { id: "bug_1", title: "Checkout failed" } } });
    await adapter.invoke("catchfn.bug-reports.create", { ...report, id: "bug_2", timestamp: 1 }, context);
    await expect(adapter.invoke("catchfn.bug-reports.get", { id: "bug_1" }, context)).resolves.toMatchObject({ data: { item: { id: "bug_1" } } });
    const first = await adapter.invoke("catchfn.bug-reports.list", { limit: 1 }, context);
    expect(first.data).toMatchObject({ items: [{ id: "bug_1" }], nextCursor: expect.any(String) });
    await expect(adapter.invoke(
      "catchfn.bug-reports.list",
      { limit: 1, cursor: (first.data as { nextCursor: string }).nextCursor },
      context,
    )).resolves.toMatchObject({ data: { items: [{ id: "bug_2" }], nextCursor: null } });
  });

  it("is explicitly nested under WatchFn and enforces its bound scope", async () => {
    expect(catchFnAdminCapability.owner).toEqual({ moduleId: "watchfn", mountPath: "/modules/watchfn/errors" });
    const adapter = createCatchFnAdminAdapter(createCatchFnAdminService(new CatchFnService({ db: memoryAdapter({ debug: false }) }), scope));
    await expect(adapter.invoke("catchfn.bug-reports.list", {}, { ...context, scope: { ...scope, projectId: "other" } })).rejects.toMatchObject({ code: "forbidden" });
  });
});
