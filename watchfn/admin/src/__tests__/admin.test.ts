import { describe, expect, it } from "vitest";
import { WatchFn } from "@watchfn/core";
import type { AdminClient } from "@superfunctions/admin";
import { createWatchFnAdminAdapter, createWatchFnAdminClient, createWatchFnAdminService, watchFnAdminCapability } from "../index.js";

const scope = { organizationId: "org_1", workspaceId: "workspace_1", projectId: "project_1", environmentId: "env_1", namespace: "tenant_1" };
const context = { scope, actor: { id: "operator_1" }, requestId: "request_1", source: "console" as const };

function setup(boundScope = scope) {
  const watch = new WatchFn({ name: "admin-test", storage: "memory", infra: { enabled: false, interval: 30_000, system: false, process: false }, errors: { enabled: false, captureUnhandled: false, captureRejections: false }, apm: { enabled: false, sampleRate: 1, slowRequestThreshold: 1000 } });
  watch.start();
  return { watch, adapter: createWatchFnAdminAdapter(createWatchFnAdminService(watch, boundScope)) };
}

describe("@watchfn/admin", () => {
  it("preserves the uniform capability client alongside named methods", () => {
    const client = createWatchFnAdminClient({} as AdminClient);
    expect(Object.keys(client.operations)).toHaveLength(watchFnAdminCapability.operations.length);
    for (const method of [client.availability, client.invoke, client.raw, client.pages, client.listEvents]) expect(typeof method).toBe("function");
  });
  it("captures and queries events through the real WatchFn runtime", async () => {
    const { watch, adapter } = setup();
    await adapter.invoke("watchfn.events.capture-message", { message: "deployment complete" }, context);
    await expect(adapter.invoke("watchfn.events.list", { limit: 10 }, context)).resolves.toMatchObject({ data: { items: [{ type: "message", message: "deployment complete" }] } });
    watch.stop();
  });

  it("creates and lists alerts through WatchFn AlertManager", async () => {
    const { watch, adapter } = setup();
    await adapter.invoke("watchfn.alerts.create", { name: "High latency", condition: { metric: "latency", operator: "gt", threshold: 500, window: "5m" }, channels: [] }, context);
    await expect(adapter.invoke("watchfn.alerts.list", {}, context)).resolves.toMatchObject({ data: { items: [{ name: "High latency" }] } });
    await expect(adapter.invoke("watchfn.alerts.list", { status: "active" }, context)).rejects.toMatchObject({ code: "invalid_argument" });
    expect(watchFnAdminCapability.operations.find(({ id }) => id === "watchfn.alerts.list")?.inputSchema.properties).toEqual({});
    expect(watchFnAdminCapability.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ moduleId: "catchfn" }), expect.objectContaining({ moduleId: "logfn" })]));
    watch.stop();
  });

  it("rejects access from a scope other than the runtime binding", async () => {
    const { watch, adapter } = setup();
    await expect(adapter.invoke("watchfn.events.list", {}, { ...context, scope: { ...scope, environmentId: "other" } })).rejects.toMatchObject({ code: "forbidden" });
    watch.stop();
  });

  it("accepts the canonical installation root without the deprecated organization alias", async () => {
    const installationScope = { installationId: "org_1", workspaceId: "workspace_1", projectId: "project_1", environmentId: "env_1", namespace: "tenant_1" };
    const { watch, adapter } = setup(installationScope);
    await expect(adapter.invoke("watchfn.events.list", {}, { ...context, scope: installationScope })).resolves.toMatchObject({ data: { items: [] } });
    watch.stop();
  });

  it("fails closed instead of claiming a capture when WatchFn is stopped", async () => {
    const { watch, adapter } = setup();
    watch.stop();
    await expect(adapter.invoke(
      "watchfn.events.capture-message",
      { message: "this must not be dropped silently" },
      context,
    )).rejects.toMatchObject({ code: "precondition_failed" });
    await expect(adapter.invoke(
      "watchfn.errors.capture",
      { name: "StoppedRuntime", message: "this must not be dropped silently" },
      context,
    )).rejects.toMatchObject({ code: "precondition_failed" });
  });
});
