import { describe, expect, it } from "vitest";
import { createAdminCapabilityAdapter } from "./adapter.js";
import { AdminError } from "./errors.js";
import { createAdminRegistry } from "./registry.js";
import { testAdapter, testManifest } from "./test-fixtures.js";
import { validateAdminCapabilityManifest } from "./validator.js";

describe("AdminCapabilityRegistry", () => {
  it("exposes only explicitly enabled modules and permits a shell-only install", () => {
    const first = testAdapter("firstfn");
    const second = testAdapter("secondfn");
    const registry = createAdminRegistry({
      adapters: [first, second],
      enabledModules: ["secondfn"],
    });
    expect(registry.enabledModuleIds).toEqual(["secondfn"]);
    expect(
      registry.operations.every((entry) => entry.moduleId === "secondfn"),
    ).toBe(true);
    expect(registry.navigation.map((entry) => entry.moduleId)).toEqual([
      "secondfn",
    ]);
    expect(registry.getManifest("firstfn")).toBeUndefined();
    expect(JSON.stringify(registry.toJSON())).not.toContain("firstfn");
    expect(registry.matchMcpTool("superconsole_firstfn_records_list")).toBeUndefined();
    expect(
      createAdminRegistry({ adapters: [first], enabledModules: [] }).operations,
    ).toEqual([]);
  });

  it("fails closed when the explicit allowlist is missing at runtime", () => {
    expect(() => createAdminRegistry({ adapters: [] } as never)).toThrowError(
      /explicit enabledModules/,
    );
  });

  it("fails startup for missing or unknown adapter handlers", () => {
    const manifest = testManifest("examplefn");
    expect(() => createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(manifest, {})],
      enabledModules: ["examplefn"],
    })).toThrowError(/exact handler coverage/);
    expect(() => createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(manifest, {
        [manifest.operations[0]!.id]: async () => ({ ok: true as const, data: { items: [] } }),
        "examplefn.records.typo": async () => ({ ok: true as const, data: { items: [] } }),
      })],
      enabledModules: ["examplefn"],
    })).toThrowError(/exact handler coverage/);
  });

  it("orders dependencies before dependents and requires nested owners", () => {
    const owner = testAdapter("ownerfn");
    const nested = testAdapter("nestedfn", {
      availability: "nested",
      owner: { moduleId: "ownerfn", mountPath: "/modules/ownerfn/nested" },
      dependencies: ["ownerfn"],
      navigation: [
        {
          id: "nestedfn",
          label: "nestedfn",
          path: "/modules/ownerfn/nested",
        },
      ],
    });
    expect(() =>
      createAdminRegistry({
        adapters: [owner, nested],
        enabledModules: ["nestedfn"],
      }),
    ).toThrowError(/requires enabled module ownerfn/);
    const registry = createAdminRegistry({
      adapters: [nested, owner],
      enabledModules: ["nestedfn", "ownerfn"],
    });
    expect(registry.enabledModuleIds).toEqual(["ownerfn", "nestedfn"]);
    expect(
      registry.navigation.find((entry) => entry.moduleId === "nestedfn")
        ?.ownerModuleId,
    ).toBe("ownerfn");
  });

  it("detects dependency cycles", () => {
    const first = testAdapter("firstfn", { dependencies: ["secondfn"] });
    const second = testAdapter("secondfn", { dependencies: ["firstfn"] });
    expect(() =>
      createAdminRegistry({
        adapters: [first, second],
        enabledModules: ["firstfn", "secondfn"],
      }),
    ).toThrowError(/dependency cycle/);
  });

  it("detects operation and parameter-equivalent route collisions", () => {
    const manifest = testManifest("examplefn");
    const operation = manifest.operations[0]!;
    const invalid = testManifest("examplefn", {
      operations: [
        {
          ...operation,
          id: "examplefn.records.first",
          route: { method: "GET", path: "/records/:id" },
        },
        {
          ...operation,
          id: "examplefn.records.second",
          route: { method: "GET", path: "/records/{recordId}" },
        },
      ],
    });
    expect(validateAdminCapabilityManifest(invalid)).toContainEqual(
      expect.objectContaining({ message: "duplicates another route" }),
    );
    expect(() =>
      createAdminRegistry({
        adapters: [createAdminCapabilityAdapter(invalid, {})],
        enabledModules: ["examplefn"],
      }),
    ).toThrow(AdminError);
  });

  it("matches concrete paths against parameterized registry routes", () => {
    const manifest = testManifest("examplefn");
    const operation = manifest.operations[0]!;
    const adapter = createAdminCapabilityAdapter(
      testManifest("examplefn", {
        operations: [
          {
            ...operation,
            inputSchema: {
              type: "object",
              properties: { id: { type: "string", minLength: 1 } },
              required: ["id"],
              additionalProperties: false,
            },
            route: { method: "GET", path: "/records/:id" },
            target: { resource: "records", idInput: "id" },
          },
        ],
      }),
      { [operation.id]: async () => ({ ok: true as const, data: { items: [] } }) },
    );
    const registry = createAdminRegistry({
      adapters: [adapter],
      enabledModules: ["examplefn"],
    });
    expect(
      registry.matchRoute(
        "GET",
        "/api/admin/v1/modules/examplefn/records/record-1",
      )?.operation.id,
    ).toBe(operation.id);
  });
});

describe("manifest validation", () => {
  it("rejects external, ambiguous, traversing, and cross-module navigation paths", () => {
    const unsafePaths = [
      "https://evil.example/modules/examplefn",
      "//evil.example/modules/examplefn",
      "/modules/examplefn@evil.example/path",
      "/modules/examplefn/%2e%2e/authfn",
      "/modules/examplefn?next=//evil.example",
      "/modules/examplefn\\credentials",
      "/modules/otherfn",
    ];

    for (const path of unsafePaths) {
      const invalid = testManifest("examplefn", {
        navigation: [{ id: "examplefn", label: "ExampleFn", path }],
      });
      expect(
        validateAdminCapabilityManifest(invalid).some(
          (issue) => issue.path === "$.navigation[0].path",
        ),
        path,
      ).toBe(true);
    }
  });

  it("requires nested mounts under their owner and safe health and route paths", () => {
    const nested = testManifest("nestedfn", {
      availability: "nested",
      owner: { moduleId: "ownerfn", mountPath: "/modules/otherfn/nested" },
      navigation: [
        {
          id: "nestedfn",
          label: "NestedFn",
          path: "/modules/ownerfn/nestedfn",
        },
      ],
      health: { path: "//health.example/status" },
      operations: [
        {
          ...testManifest("nestedfn").operations[0]!,
          route: "GET /resources/%2e%2e/secrets",
        },
      ],
    });
    const issues = validateAdminCapabilityManifest(nested);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.owner.mountPath",
          message: "must be mounted under /modules/ownerfn",
        }),
        expect.objectContaining({ path: "$.health.path" }),
        expect.objectContaining({ path: "$.operations[0].route" }),
      ]),
    );
  });

  it("requires health metadata to resolve to a declared read operation", () => {
    const base = testManifest("examplefn");
    const missing = testManifest("examplefn", {
      health: { operationId: "examplefn.health.list" },
    });
    const phantomPath = testManifest("examplefn", {
      health: { path: "/health" },
    });
    const nonRead = testManifest("examplefn", {
      health: { operationId: "examplefn.records.refresh" },
      operations: [
        {
          ...base.operations[0]!,
          id: "examplefn.records.refresh",
          route: { method: "POST", path: "/resources/records/refresh" },
          safety: { classification: "write", idempotent: true, audit: "required" },
          mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
      ],
    });

    expect(validateAdminCapabilityManifest(missing)).toContainEqual(
      expect.objectContaining({
        path: "$.health.operationId",
        message: "must name a declared operation",
      }),
    );
    expect(validateAdminCapabilityManifest(phantomPath)).toContainEqual(
      expect.objectContaining({
        path: "$.health.path",
        message: "must exactly match a declared read route",
      }),
    );
    expect(validateAdminCapabilityManifest(nonRead)).toContainEqual(
      expect.objectContaining({
        path: "$.health.operationId",
        message: "must name a read operation",
      }),
    );
    expect(
      validateAdminCapabilityManifest(
        testManifest("examplefn", {
          health: { operationId: "examplefn.records.list" },
        }),
      ).filter((issue) => issue.path.startsWith("$.health")),
    ).toEqual([]);
  });

  it("requires explicit target semantics for every operation", () => {
    const manifest = testManifest("examplefn");
    const invalid = testManifest("examplefn", {
      operations: [
        {
          ...manifest.operations[0]!,
          target: undefined,
        } as unknown as (typeof manifest.operations)[number],
      ],
    });

    expect(validateAdminCapabilityManifest(invalid)).toContainEqual(
      expect.objectContaining({
        path: "$.operations[0].target",
        message: "operations must declare a resource or collection target",
      }),
    );
  });

  it("rejects unsafe destructive operations", () => {
    const manifest = testManifest("examplefn");
    const invalid = testManifest("examplefn", {
      operations: [
        {
          ...manifest.operations[0]!,
          safety: {
            classification: "destructive",
            idempotent: true,
            audit: "optional",
            requiresConfirmation: false,
          },
        },
      ],
    });
    const issues = validateAdminCapabilityManifest(invalid);
    expect(issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "mutations must require audit",
        "destructive operations must require confirmation",
        "destructive targets must identify one resource",
      ]),
    );
  });

  it("requires destructive target identifiers in the input contract", () => {
    const manifest = testManifest("examplefn");
    const invalid = testManifest("examplefn", {
      operations: [
        {
          ...manifest.operations[0]!,
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            additionalProperties: false,
          },
          safety: {
            classification: "destructive",
            idempotent: true,
            audit: "required",
            requiresConfirmation: true,
          },
          target: { resource: "records", idInput: "id" },
        },
      ],
    });
    expect(
      validateAdminCapabilityManifest(invalid).map((issue) => issue.message),
    ).toContain("must require the target idInput");
  });

  it("binds targets to the operation resource segment", () => {
    const manifest = testManifest("examplefn");
    const invalid = testManifest("examplefn", {
      operations: [
        {
          ...manifest.operations[0]!,
          target: { resource: "other-records", collection: true },
        },
      ],
    });

    expect(validateAdminCapabilityManifest(invalid)).toContainEqual(
      expect.objectContaining({
        path: "$.operations[0].target.resource",
        message: "must match the resource segment in the operation id",
      }),
    );
  });

  it("requires audit whenever an operation declares sensitive fields", () => {
    const manifest = testManifest("examplefn");
    const invalid = testManifest("examplefn", {
      operations: [
        {
          ...manifest.operations[0]!,
          redaction: { outputFields: ["privateBody"] },
          safety: {
            classification: "read",
            idempotent: true,
            audit: "optional",
          },
        },
      ],
    });

    expect(validateAdminCapabilityManifest(invalid)).toContainEqual(
      expect.objectContaining({
        path: "$.operations[0].safety.audit",
        message: "operations with declared sensitive fields must require audit",
      }),
    );
  });

  it("rejects ambiguous sensitive field declarations", () => {
    const manifest = testManifest("examplefn");
    const invalid = testManifest("examplefn", {
      operations: [
        {
          ...manifest.operations[0]!,
          redaction: { outputFields: ["apiKey", "api_key", "payload.secret"] },
          safety: {
            classification: "read",
            idempotent: true,
            audit: "required",
          },
        },
      ],
    });
    const messages = validateAdminCapabilityManifest(invalid).map(
      (issue) => issue.message,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        "must contain unique normalized field names",
        "must contain simple field names rather than paths",
      ]),
    );
  });

  it("rejects destructive collection targets", () => {
    const manifest = testManifest("examplefn");
    const invalid = testManifest("examplefn", {
      operations: [
        {
          ...manifest.operations[0]!,
          safety: {
            classification: "destructive",
            idempotent: true,
            audit: "required",
            requiresConfirmation: true,
          },
          target: { resource: "records", collection: true },
          mcp: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
          },
        },
      ],
    });

    expect(validateAdminCapabilityManifest(invalid)).toContainEqual(
      expect.objectContaining({
        path: "$.operations[0].target",
        message: "destructive targets must identify one resource",
      }),
    );
  });
});
