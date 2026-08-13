import { describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/testing";
import { createAdminRegistry, type AdminClient } from "@superfunctions/admin";
import { createContentfnServer } from "@contentfn/server";
import { cmsFnAdminCapability, createCmsFnAdminAdapter, createCmsFnAdminClient, createCmsFnAdminService } from "../index.js";

const context = { scope: { installationId: "install_1", workspaceId: "workspace_1", projectId: "project_1", environmentId: "prod" }, actor: { id: "operator_1" }, requestId: "request_1", source: "console" as const };
const schema = { version: 1, documentTypes: [{ name: "post", fields: [{ name: "title", type: { kind: "primitive" as const, type: "string" as const }, required: true }] }] };

function setup() {
  const contentfn = createContentfnServer({ db: memoryAdapter({ debug: false }) });
  return createCmsFnAdminAdapter(createCmsFnAdminService({ contentfn }));
}

describe("@cmsfn/admin", () => {
  it("preserves the uniform capability client alongside named methods", () => {
    const client = createCmsFnAdminClient({} as AdminClient);
    expect(Object.keys(client.operations)).toHaveLength(cmsFnAdminCapability.operations.length);
    for (const method of [client.availability, client.invoke, client.raw, client.pages, client.documents.list]) expect(typeof method).toBe("function");
  });
  it("folds ContentFn into CmsFn and advertises only backed operations", () => {
    expect(cmsFnAdminCapability.dependencies).toEqual([]);
    expect(createAdminRegistry({ adapters: [setup()], enabledModules: ["cmsfn"] }).enabledModuleIds).toEqual(["cmsfn"]);
    expect(cmsFnAdminCapability.operations.map((operation) => operation.id)).toContain("cmsfn.documents.list");
    expect(cmsFnAdminCapability.operations.map((operation) => operation.id)).not.toContain("cmsfn.datasets.delete");
    expect(cmsFnAdminCapability.operations.some((operation) => operation.id.includes("workflows"))).toBe(false);
  });

  it("creates the scoped dataset/schema/document and queries it through ContentFn", async () => {
    const adapter = setup();
    await expect(adapter.invoke("cmsfn.datasets.create", {}, context)).resolves.toMatchObject({ data: { item: { id: "prod" } } });
    await adapter.invoke("cmsfn.schemas.upsert", { schema }, context);
    await expect(adapter.invoke("cmsfn.documents.create", { id: "post_1", type: "post", document: { title: "Hello" }, asDraft: false }, context)).resolves.toMatchObject({ data: { item: { _id: "post_1", title: "Hello" } } });
    await expect(adapter.invoke("cmsfn.documents.list", { limit: 10 }, context)).resolves.toMatchObject({ data: { items: [{ _id: "post_1", title: "Hello" }], nextCursor: null } });
  });

  it("derives dataset identity from the active environment instead of accepting an object-scope override", async () => {
    const adapter = setup();
    await adapter.invoke("cmsfn.datasets.create", {}, context);
    await expect(adapter.invoke("cmsfn.schemas.get", {}, { ...context, scope: { ...context.scope, environmentId: "other" } })).rejects.toMatchObject({ code: "not_found" });
  });

  it("maps ContentFn schema absence to a canonical not-found admin error", async () => {
    const adapter = setup();
    await adapter.invoke("cmsfn.datasets.create", {}, context);
    await expect(adapter.invoke("cmsfn.schemas.get", {}, context)).rejects.toMatchObject({ code: "not_found" });
  });
});
