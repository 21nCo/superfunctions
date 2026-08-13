import { describe, expect, it, vi } from "vitest";
import { Logger, type LogEvent, type Sink } from "@logfn/core";
import type { AdminClient } from "@superfunctions/admin";
import { createLogFnAdminAdapter, createLogFnAdminClient, createLogFnAdminService, logFnAdminCapability } from "../index.js";

const scope = { organizationId: "org_1", workspaceId: "workspace_1", projectId: "project_1", environmentId: "env_1", namespace: "tenant_1" };
const context = { scope, actor: { id: "operator_1" }, requestId: "request_1", source: "console" as const };

describe("@logfn/admin", () => {
  it("preserves the uniform capability client alongside named methods", () => {
    const client = createLogFnAdminClient({} as AdminClient);
    expect(Object.keys(client.operations)).toHaveLength(logFnAdminCapability.operations.length);
    for (const method of [client.availability, client.invoke, client.raw, client.pages, client.emit]) expect(typeof method).toBe("function");
  });
  it("emits and flushes through the configured LogFn logger and sink", async () => {
    const events: LogEvent[] = [];
    const flush = vi.fn(async () => undefined);
    const sink: Sink = Object.assign((batch: LogEvent[]) => { events.push(...batch); }, { flush });
    const adapter = createLogFnAdminAdapter(createLogFnAdminService(new Logger({ name: "admin", sinks: [sink] }), scope));
    await adapter.invoke("logfn.events.emit", { level: "warn", message: "rotation due", tags: ["operator"] }, context);
    expect(events).toMatchObject([{ level: "warn", msg: "rotation due", ctx: { adminActorId: "operator_1", environmentId: "env_1" } }]);
    await adapter.invoke("logfn.sinks.flush", {}, context);
    expect(flush).toHaveBeenCalledOnce();
  });

  it("is a typed nested WatchFn capability and rejects cross-scope use", async () => {
    expect(logFnAdminCapability.owner).toEqual({ moduleId: "watchfn", mountPath: "/modules/watchfn/logs" });
    const adapter = createLogFnAdminAdapter(createLogFnAdminService(new Logger({ name: "admin", sinks: [() => undefined] }), scope));
    await expect(adapter.invoke("logfn.sinks.flush", {}, { ...context, scope: { ...scope, workspaceId: "other" } })).rejects.toMatchObject({ code: "forbidden" });
  });
});
