import { describe, expect, it, vi } from "vitest";
import { createAdminCapabilityAdapter } from "./adapter.js";
import { MemoryAdminAuditSink } from "./audit.js";
import { createAdminDispatcher } from "./dispatcher.js";
import { AdminError } from "./errors.js";
import { adminInputFingerprint, MemoryAdminIdempotencyStore } from "./idempotency.js";
import { createAdminRegistry } from "./registry.js";
import { testManifest } from "./test-fixtures.js";
import type { AdminOperationContext } from "./types.js";

const context = (overrides: Partial<AdminOperationContext> = {}): AdminOperationContext => ({
  scope: {
    organizationId: "org_1",
    workspaceId: "ws_1",
    projectId: "project_1",
    environmentId: "env_1",
    namespace: "tenant_1",
    region: "in-south",
  },
  actor: { id: "user_1", permissions: ["examplefn.records.read"] },
  requestId: "req_1",
  correlationId: "corr_1",
  source: "rest",
  ...overrides,
});

describe("AdminDispatcher", () => {
  it("stores stable hashed idempotency fingerprints instead of raw input", async () => {
    const first = await adminInputFingerprint({ id: "1", apiToken: "raw-secret" });
    const equivalent = await adminInputFingerprint({ apiToken: "raw-secret", id: "1" });
    const different = await adminInputFingerprint({ id: "1", apiToken: "different" });

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first).not.toContain("raw-secret");
    expect(equivalent).toBe(first);
    expect(different).not.toBe(first);
  });

  it("validates input, permissions, and output without throwing unsafe domain errors", async () => {
    const manifest = testManifest();
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: { items: [] },
      auditId: "untrusted-domain-audit",
      requestId: "untrusted-domain-request",
    }));
    const registry = createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(manifest, { [manifest.operations[0]!.id]: handler })],
      enabledModules: [manifest.id],
    });
    const dispatcher = createAdminDispatcher({ registry });

    expect(await dispatcher.dispatch({ operationId: "examplefn.records.list", input: { limit: 20 }, context: context() })).toMatchObject({ ok: true, data: { items: [] }, requestId: "req_1" });
    expect(await dispatcher.dispatch({ operationId: "examplefn.records.list", input: {}, context: context() })).not.toHaveProperty("auditId");
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ input: { limit: 20 }, context: expect.objectContaining({ scope: expect.objectContaining({ environmentId: "env_1" }) }) }));

    expect(await dispatcher.dispatch({ operationId: "examplefn.records.list", input: { limit: 1000 }, context: context() })).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(await dispatcher.dispatch({ operationId: "examplefn.records.list", input: {}, context: context({ actor: { id: "denied", permissions: [] } }) })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("never returns an audit receipt when the sink rejected the event", async () => {
    const manifest = testManifest("examplefn", {
      operations: [
        {
          ...testManifest().operations[0]!,
          safety: { classification: "read", idempotent: true, audit: "required" },
        },
      ],
    });
    const registry = createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(manifest, {
        "examplefn.records.list": async () => ({ ok: true as const, data: { items: [] } }),
      })],
      enabledModules: ["examplefn"],
    });
    const audit = {
      write: vi.fn(async () => {
        throw new Error("sink unavailable");
      }),
    };

    const result = await createAdminDispatcher({
      registry,
      audit,
      createAuditId: () => "audit_unwritten",
    }).dispatch({
      operationId: "examplefn.records.list",
      input: {},
      context: context(),
    });

    expect(result).toMatchObject({ ok: false, error: { code: "dependency_unavailable" } });
    expect(result).not.toHaveProperty("auditId");
    expect(audit.write).toHaveBeenCalledTimes(1);
  });

  it("continues optional-audit reads without fabricating a receipt", async () => {
    const manifest = testManifest();
    const registry = createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(manifest, {
        "examplefn.records.list": async () => ({ ok: true as const, data: { items: [] } }),
      })],
      enabledModules: ["examplefn"],
    });
    const result = await createAdminDispatcher({
      registry,
      audit: {
        write: async () => {
          throw new Error("optional sink unavailable");
        },
      },
    }).dispatch({
      operationId: "examplefn.records.list",
      input: {},
      context: context(),
    });

    expect(result).toMatchObject({ ok: true, data: { items: [] } });
    expect(result).not.toHaveProperty("auditId");
  });

  it("records a sanitized attempt before invoking a required-audit mutation", async () => {
    const base = testManifest().operations[0]!;
    const manifest = testManifest("examplefn", {
      operations: [
        {
          ...base,
          id: "examplefn.records.rotate",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
              apiToken: { type: "string" },
            },
            required: ["id", "apiToken"],
            additionalProperties: false,
          },
          route: { method: "POST", path: "/records/:id/rotate" },
          permission: "examplefn.records.rotate",
          safety: { classification: "write", idempotent: true, audit: "required" },
          target: { resource: "records", idInput: "id" },
          redaction: { inputFields: ["apiToken"] },
          mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
      ],
    });
    const handler = vi.fn(async () => ({ ok: true as const, data: { items: [] } }));
    const registry = createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(manifest, {
        "examplefn.records.rotate": handler,
      })],
      enabledModules: ["examplefn"],
    });
    const attempted: Array<{ outcome: string; input: unknown }> = [];
    let auditAvailable = false;
    const audit = {
      write: vi.fn(async (event: { outcome: string; input: unknown }) => {
        attempted.push(event);
        if (event.outcome === "attempted" && !auditAvailable) throw new Error("sink unavailable");
      }),
    };
    const dispatcher = createAdminDispatcher({
      registry,
      audit,
      idempotency: new MemoryAdminIdempotencyStore(),
    });
    const dispatch = () => dispatcher.dispatch({
      operationId: "examplefn.records.rotate",
      input: { id: "record_1", apiToken: "raw-secret" },
      context: context({
        actor: { id: "user_1", permissions: ["examplefn.records.rotate"] },
        idempotencyKey: "attempted",
      }),
    });
    const result = await dispatch();

    expect(handler).not.toHaveBeenCalled();
    expect(attempted[0]).toMatchObject({
      outcome: "attempted",
      input: { id: "record_1", apiToken: "[REDACTED]" },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "dependency_unavailable", retryable: true },
    });
    expect(audit.write).toHaveBeenCalledTimes(1);

    auditAvailable = true;
    await expect(dispatch()).resolves.toMatchObject({ ok: true, data: { items: [] } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(attempted.map(({ outcome }) => outcome)).toEqual(["attempted", "attempted", "succeeded"]);
  });

  it("records attempted then failed when a domain mutation throws", async () => {
    const base = testManifest().operations[0]!;
    const manifest = testManifest("examplefn", {
      operations: [
        {
          ...base,
          id: "examplefn.records.rotate",
          route: { method: "POST", path: "/records/rotate" },
          permission: "examplefn.records.rotate",
          safety: { classification: "write", idempotent: true, audit: "required" },
          mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
      ],
    });
    const audit = new MemoryAdminAuditSink();
    const registry = createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(manifest, {
        "examplefn.records.rotate": async () => {
          throw new AdminError("conflict", "Cannot rotate.");
        },
      })],
      enabledModules: ["examplefn"],
    });

    const result = await createAdminDispatcher({
      registry,
      audit,
      idempotency: new MemoryAdminIdempotencyStore(),
    }).dispatch({
      operationId: "examplefn.records.rotate",
      input: {},
      context: context({
        actor: { id: "user_1", permissions: ["examplefn.records.rotate"] },
        idempotencyKey: "domain-failure",
      }),
    });

    expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(audit.events.map((event) => event.outcome)).toEqual([
      "attempted",
      "failed",
    ]);
    expect(result.auditId).toBe(audit.events[1]?.id);
  });

  it("returns no receipt when a terminal mutation audit write fails", async () => {
    const base = testManifest().operations[0]!;
    const manifest = testManifest("examplefn", {
      operations: [
        {
          ...base,
          id: "examplefn.records.rotate",
          route: { method: "POST", path: "/records/rotate" },
          permission: "examplefn.records.rotate",
          safety: { classification: "write", idempotent: true, audit: "required" },
          mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
      ],
    });
    const handler = vi.fn(async () => ({ ok: true as const, data: { items: [] } }));
    let writes = 0;
    const registry = createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(manifest, {
        "examplefn.records.rotate": handler,
      })],
      enabledModules: ["examplefn"],
    });
    const result = await createAdminDispatcher({
      registry,
      audit: {
        write: async () => {
          writes += 1;
          if (writes > 1) throw new Error("terminal sink unavailable");
        },
      },
      idempotency: new MemoryAdminIdempotencyStore(),
    }).dispatch({
      operationId: "examplefn.records.rotate",
      input: {},
      context: context({
        actor: { id: "user_1", permissions: ["examplefn.records.rotate"] },
        idempotencyKey: "terminal-audit",
      }),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(writes).toBe(2);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "dependency_unavailable" },
    });
    expect(result).not.toHaveProperty("auditId");
  });

  it("enforces confirmation, required audit, idempotency replay, conflict, and redaction", async () => {
    const read = testManifest().operations[0]!;
    const manifest = testManifest("examplefn", {
      operations: [{
        ...read,
        id: "examplefn.records.delete",
        title: "Delete record",
        inputSchema: { type: "object", properties: { id: { type: "string" }, apiToken: { type: "string" }, webhookToken: { type: "string" } }, required: ["id", "apiToken"], additionalProperties: false },
        outputSchema: { type: "object", properties: { deleted: { type: "boolean" }, privateBody: { type: "string" }, statusCode: { type: "integer" }, sessionCount: { type: "integer" }, authorization: { type: "string" } }, required: ["deleted", "privateBody", "statusCode", "sessionCount", "authorization"], additionalProperties: false },
        route: { method: "DELETE", path: "/records/:id" },
        permission: "examplefn.records.delete",
        safety: { classification: "destructive", idempotent: true, requiresConfirmation: true, audit: "required" },
        target: { resource: "records", idInput: "id" },
        redaction: { inputFields: ["apiToken"], outputFields: ["privateBody"] },
        mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      }],
    });
    const handler = vi.fn(async () => ({ ok: true as const, data: { deleted: true, privateBody: "raw-private", statusCode: 204, sessionCount: 3, authorization: "domain-value" } }));
    const registry = createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(manifest, { "examplefn.records.delete": handler })],
      enabledModules: ["examplefn"],
    });
    const noInfrastructure = createAdminDispatcher({ registry });
    const baseContext = context({
      actor: { id: "user_1", permissions: ["examplefn.records.delete"] },
      confirmationToken: "confirmed",
      idempotencyKey: "idem_1",
    });
    const infrastructureFailure = await noInfrastructure.dispatch({ operationId: "examplefn.records.delete", input: { id: "1", apiToken: "raw-secret" }, context: baseContext });
    expect(infrastructureFailure).toMatchObject({ ok: false, error: { code: "dependency_unavailable" } });
    expect(infrastructureFailure).not.toHaveProperty("auditId");

    const audit = new MemoryAdminAuditSink();
    const idempotency = new MemoryAdminIdempotencyStore();
    const dispatcher = createAdminDispatcher({ registry, audit, idempotency, confirmation: { verify: ({ token }) => token === "confirmed" }, createAuditId: () => "audit_1" });
    expect(await dispatcher.dispatch({ operationId: "examplefn.records.delete", input: { id: "1", apiToken: "raw-secret" }, context: { ...baseContext, confirmationToken: undefined } })).toMatchObject({ ok: false, error: { code: "precondition_failed" } });
    const first = await dispatcher.dispatch({ operationId: "examplefn.records.delete", input: { id: "1", apiToken: "raw-secret", webhookToken: "implicit-secret" }, context: baseContext });
    const replay = await dispatcher.dispatch({ operationId: "examplefn.records.delete", input: { id: "1", apiToken: "raw-secret", webhookToken: "implicit-secret" }, context: { ...baseContext, requestId: "req_2" } });
    expect(first).toMatchObject({ ok: true, data: { deleted: true, privateBody: "[REDACTED]", statusCode: 204, sessionCount: 3, authorization: "domain-value" }, auditId: "audit_1" });
    expect(replay).toMatchObject({ ok: true, data: { deleted: true, privateBody: "[REDACTED]", statusCode: 204, sessionCount: 3, authorization: "domain-value" }, meta: { idempotencyReplay: true } });
    expect(handler).toHaveBeenCalledTimes(1); // missing required infrastructure fails before domain execution
    expect(audit.events.at(-1)?.input).toEqual({ id: "1", apiToken: "[REDACTED]", webhookToken: "[REDACTED]" });
    expect(audit.events.slice(-3).map((event) => event.outcome)).toEqual(["attempted", "succeeded", "replayed"]);
    expect(replay).toMatchObject({ auditId: "audit_1", meta: { originalAuditId: "audit_1" } });
    expect(await dispatcher.dispatch({ operationId: "examplefn.records.delete", input: { id: "2", apiToken: "different" }, context: baseContext })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("requires the universal four-level context", async () => {
    const manifest = testManifest();
    const registry = createAdminRegistry({ adapters: [createAdminCapabilityAdapter(manifest, { "examplefn.records.list": async () => ({ ok: true as const, data: { items: [] } }) })], enabledModules: ["examplefn"] });
    const result = await createAdminDispatcher({ registry }).dispatch({ operationId: "examplefn.records.list", input: {}, context: { ...context(), scope: { ...context().scope, environmentId: "" } } });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
  });

  it("always ANDs manifest permission with a custom contextual policy", async () => {
    const manifest = testManifest();
    const handler = vi.fn(async () => ({ ok: true as const, data: { items: [] } }));
    const registry = createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(manifest, { "examplefn.records.list": handler })],
      enabledModules: ["examplefn"],
    });
    const dispatcher = createAdminDispatcher({ registry, policy: { authorize: () => ({ allowed: true }) } });

    await expect(dispatcher.dispatch({
      operationId: "examplefn.records.list",
      input: {},
      context: context({ actor: { id: "denied", permissions: [] } }),
    })).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(handler).not.toHaveBeenCalled();

    await expect(dispatcher.dispatch({
      operationId: "examplefn.records.list",
      input: {},
      context: context(),
    })).resolves.toMatchObject({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not reserve or require idempotency storage for reads", async () => {
    const manifest = testManifest();
    const handler = vi.fn(async () => ({ ok: true as const, data: { items: [] } }));
    const registry = createAdminRegistry({ adapters: [createAdminCapabilityAdapter(manifest, { "examplefn.records.list": handler })], enabledModules: ["examplefn"] });
    await expect(createAdminDispatcher({ registry }).dispatch({
      operationId: "examplefn.records.list",
      input: {},
      context: context({ idempotencyKey: "ignored-on-read" }),
    })).resolves.toMatchObject({ ok: true, data: { items: [] } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("passes one immutable post-validation snapshot to policy and domain hooks", async () => {
    const manifest = testManifest();
    const handler = vi.fn(async ({ input, context: operationContext }) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(operationContext)).toBe(true);
      expect(Object.isFrozen(operationContext.scope)).toBe(true);
      return { ok: true as const, data: { items: [{ input, scope: operationContext.scope }] } };
    });
    const registry = createAdminRegistry({ adapters: [createAdminCapabilityAdapter(manifest, { "examplefn.records.list": handler })], enabledModules: ["examplefn"] });
    const dispatcher = createAdminDispatcher({
      registry,
      policy: {
        authorize: ({ input, context: operationContext }) => {
          expect(Reflect.set(input as object, "limit", 999)).toBe(false);
          expect(Reflect.set(operationContext.scope, "environmentId", "other")).toBe(false);
          return { allowed: true };
        },
      },
    });
    const result = await dispatcher.dispatch({ operationId: "examplefn.records.list", input: { limit: 20 }, context: context() });
    expect(result).toMatchObject({ ok: true, data: { items: [{ input: { limit: 20 }, scope: { environmentId: "env_1" } }] } });
  });

  it("redacts secret error details without masking legitimate code fields", async () => {
    const manifest = testManifest();
    const registry = createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(manifest, {
        "examplefn.records.list": async () => {
          throw new AdminError("conflict", "Conflict.", {
            details: {
              apiToken: "raw",
              statusCode: 409,
              sessionCount: 2,
              sessionId: "session_secret",
              verificationCode: "123456",
            },
          });
        },
      })],
      enabledModules: ["examplefn"],
    });

    expect(
      await createAdminDispatcher({ registry }).dispatch({
        operationId: "examplefn.records.list",
        input: {},
        context: context(),
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "conflict",
        details: {
          apiToken: "[REDACTED]",
          statusCode: 409,
          sessionCount: 2,
          sessionId: "[REDACTED]",
          verificationCode: "[REDACTED]",
        },
      },
    });
  });

  it("uses declared sensitive response fields recursively", async () => {
    const base = testManifest().operations[0]!;
    const manifest = testManifest("examplefn", {
      operations: [
        {
          ...base,
          safety: { ...base.safety, audit: "required" },
          redaction: { outputFields: ["apiKey"] },
        },
      ],
    });
    const registry = createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(manifest, {
        "examplefn.records.list": async () => ({
          ok: true as const,
          data: {
            items: [{ id: "record_1", nested: { api_key: "raw", statusCode: 200 } }],
          },
          meta: { api_key: "raw-meta", statusCode: 200 },
        }),
      })],
      enabledModules: ["examplefn"],
    });

    expect(
      await createAdminDispatcher({
        registry,
        audit: new MemoryAdminAuditSink(),
      }).dispatch({
        operationId: "examplefn.records.list",
        input: {},
        context: context(),
      }),
    ).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            nested: { api_key: "[REDACTED]", statusCode: 200 },
          },
        ],
      },
      meta: { api_key: "[REDACTED]", statusCode: 200 },
    });
  });

  it("atomically reserves an idempotency key so concurrent requests execute once", async () => {
    const base = testManifest().operations[0]!;
    const manifest = testManifest("examplefn", { operations: [{
      ...base,
      id: "examplefn.records.refresh",
      outputSchema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false },
      route: { method: "POST", path: "/records/refresh" },
      permission: "examplefn.records.refresh",
      safety: { classification: "write", idempotent: true, audit: "required" },
      mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }] });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const handler = vi.fn(async () => { await blocked; return { ok: true as const, data: { accepted: true } }; });
    const registry = createAdminRegistry({ adapters: [createAdminCapabilityAdapter(manifest, { "examplefn.records.refresh": handler })], enabledModules: ["examplefn"] });
    const dispatcher = createAdminDispatcher({ registry, audit: new MemoryAdminAuditSink(), idempotency: new MemoryAdminIdempotencyStore() });
    const mutationContext = context({ actor: { id: "user_1", permissions: ["examplefn.records.refresh"] }, idempotencyKey: "atomic" });
    const first = dispatcher.dispatch({ operationId: "examplefn.records.refresh", input: {}, context: mutationContext });
    const second = dispatcher.dispatch({ operationId: "examplefn.records.refresh", input: {}, context: { ...mutationContext, requestId: "req_2" } });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ ok: true, data: { accepted: true } });
    expect(secondResult).toMatchObject({ ok: true, data: { accepted: true }, meta: { idempotencyReplay: true } });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
