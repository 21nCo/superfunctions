import { BrowseFn } from "browsefn";
import {
  createAdminDispatcher, createAdminRegistry, MemoryAdminAuditSink,
  MemoryAdminIdempotencyStore, type AdminOperationContext,
} from "@superfunctions/admin";
import { describe, expect, it, vi } from "vitest";
import { createBrowseFnAdminAdapter, createBrowseFnDomainAdminService } from "../index.js";

const scope = {
  installationId: "install_1", workspaceId: "workspace_1", projectId: "project_1",
  environmentId: "environment_1", namespace: "tenant_1", region: "in-south",
};
const context: AdminOperationContext = {
  scope, actor: { id: "operator", type: "user", permissions: ["*"] },
  requestId: "request_1", correlationId: "correlation_1", source: "console",
  idempotencyKey: "clear_1", confirmationToken: "verified-confirmation",
};
const clearInput = { id: "cache", reason: "Clear stale cached pages" };
function fixture() {
  const browsefn = new BrowseFn({ cache: { enabled: true, ttl: 60_000 } });
  const adapter = createBrowseFnAdminAdapter(createBrowseFnDomainAdminService({ browsefn, scope }));
  const registry = createAdminRegistry({ enabledModules: ["browsefn"], adapters: [adapter] });
  const audit = new MemoryAdminAuditSink();
  const idempotency = new MemoryAdminIdempotencyStore();
  // Production verifiers must validate real proof bound to the operation and scope.
  const confirmation = { verify: ({ token }: { token: string }) => token === "verified-confirmation" };
  const options = { registry, audit, idempotency, confirmation };
  return { browsefn, audit, options, dispatcher: createAdminDispatcher(options) };
}

describe("BrowseFn through the shared admin dispatcher", () => {
  it("allows permission-scoped reads and rejects denied actors and invalid input", async () => {
    const { browsefn, dispatcher } = fixture();
    const reader = { ...context, actor: { id: "reader", permissions: ["browsefn.cache.read"] } };
    expect(await dispatcher.dispatch({ operationId: "browsefn.cache.get", input: {}, context: reader }))
      .toMatchObject({ ok: true, data: { item: { id: "cache", enabled: true, size: 0 } } });
    const clear = vi.spyOn(browsefn, "clearCache");
    expect(await dispatcher.dispatch({ operationId: "browsefn.cache.clear", input: clearInput, context: reader }))
      .toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await dispatcher.dispatch({ operationId: "browsefn.cache.clear", input: { id: "wrong", reason: "x" }, context }))
      .toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(await dispatcher.dispatch({ operationId: "browsefn.logs.list", input: { limit: -1 }, context }))
      .toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(clear).not.toHaveBeenCalled();
  });

  it.each(Object.keys(scope) as Array<keyof typeof scope>)("rejects mismatched %s on reads and mutations", async field => {
    const { browsefn, dispatcher } = fixture();
    const clear = vi.spyOn(browsefn, "clearCache");
    const mismatched = { ...context, scope: { ...scope, [field]: "other" } };
    for (const [operationId, input] of [["browsefn.cache.get", {}], ["browsefn.cache.clear", clearInput]] as const) {
      expect(await dispatcher.dispatch({ operationId, input, context: mismatched }))
        .toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect(clear).not.toHaveBeenCalled();
  });

  it("rejects a contradictory organization alias", async () => {
    const { dispatcher } = fixture();
    expect(await dispatcher.dispatch({ operationId: "browsefn.providers.list", input: {}, context: {
      ...context, scope: { ...scope, organizationId: "other" },
    } })).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
  });

  it.each([
    ["missing token", "precondition_failed"], ["invalid token", "precondition_failed"],
    ["missing verifier", "dependency_unavailable"], ["missing audit", "dependency_unavailable"],
    ["missing key", "precondition_failed"], ["missing store", "dependency_unavailable"],
  ])("fails closed with %s", async (failure, code) => {
    const { browsefn, options } = fixture();
    await browsefn.cache!.set("test", "https://example.test/private", { token: "secret-value" });
    const clear = vi.spyOn(browsefn, "clearCache");
    const dispatcher = createAdminDispatcher({ ...options,
      confirmation: failure === "missing verifier" ? undefined : options.confirmation,
      audit: failure === "missing audit" ? undefined : options.audit,
      idempotency: failure === "missing store" ? undefined : options.idempotency,
    });
    const result = await dispatcher.dispatch({ operationId: "browsefn.cache.clear", input: clearInput, context: {
      ...context,
      confirmationToken: failure === "missing token" ? undefined : failure === "invalid token" ? "invalid" : context.confirmationToken,
      idempotencyKey: failure === "missing key" ? undefined : context.idempotencyKey,
    } });
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(clear).not.toHaveBeenCalled();
    expect(await browsefn.cache!.getStats()).toMatchObject({ size: 1 });
  });

  it("does not clear when the required audit intent cannot be persisted", async () => {
    const { browsefn, audit, dispatcher } = fixture();
    vi.spyOn(audit, "write").mockRejectedValue(new Error("audit unavailable"));
    const clear = vi.spyOn(browsefn, "clearCache");
    expect(await dispatcher.dispatch({ operationId: "browsefn.cache.clear", input: clearInput, context }))
      .toMatchObject({ ok: false });
    expect(clear).not.toHaveBeenCalled();
  });

  it("clears once, persists audit success, and replays without deleting newer entries", async () => {
    const { browsefn, audit, dispatcher } = fixture();
    await browsefn.cache!.set("test", "https://example.test/private", { token: "never-log-this" });
    const clear = vi.spyOn(browsefn, "clearCache");
    const request = { operationId: "browsefn.cache.clear", input: clearInput, context };
    const result = await dispatcher.dispatch(request);
    expect(result).toMatchObject({ ok: true, data: { accepted: true }, auditId: expect.any(String) });
    expect(await browsefn.cache!.getStats()).toMatchObject({ size: 0 });
    await browsefn.cache!.set("test", "https://example.test/new", { token: "new-secret" });
    expect(await dispatcher.dispatch(request)).toMatchObject({ ok: true, data: { accepted: true } });
    expect(await dispatcher.dispatch({ ...request, input: { ...clearInput, reason: "Different maintenance request" } }))
      .toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(await browsefn.cache!.getStats()).toMatchObject({ size: 1 });
    expect(audit.events.some(event => event.operationId === request.operationId && event.outcome === "succeeded")).toBe(true);
    expect(JSON.stringify(audit.events)).not.toContain("never-log-this");
    expect(JSON.stringify(audit.events)).not.toContain("new-secret");
  });

  it("returns redacted lifecycle logs through dispatch and clears them with safeguards", async () => {
    const { browsefn, dispatcher, audit } = fixture();
    const secret = "sensitive-url-token";
    await expect(browsefn.web.getPage(`invalid ${secret}`)).rejects.toThrow();
    const listed = await dispatcher.dispatch({ operationId: "browsefn.logs.list", input: { limit: 10 }, context });
    expect(listed).toMatchObject({ ok: true, data: { items: [
      { event: "request" }, { event: "error", outcome: "error" },
    ] } });
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(secret);
    for (const log of browsefn.getLogs()) if (log.requestId) expect(serialized).not.toContain(log.requestId);
    expect(await dispatcher.dispatch({ operationId: "browsefn.logs.clear", input: { id: "events", reason: "Clear lifecycle logs" }, context }))
      .toMatchObject({ ok: true, data: { accepted: true } });
    expect(browsefn.getLogs()).toEqual([]);
    expect(JSON.stringify(audit.events)).not.toContain(secret);
  });
});
