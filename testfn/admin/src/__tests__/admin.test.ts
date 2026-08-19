import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TestRunner,
  TestStorage,
  VisualTester,
  type TestCase,
  type TestFrameworkAdapter,
  type TestResult,
} from "@testfn/core";
import {
  MemoryAdminAuditSink,
  MemoryAdminIdempotencyStore,
  createAdminDispatcher,
  createAdminRegistry,
  type AdminOperationContext,
} from "@superfunctions/admin";
import {
  createTestFnDomainAdminAdapter,
  createTestFnAdminAdapter,
  createTestFnDomainAdminService,
  testFnAdminCapability,
  testFnAdminResources,
  type TestFnDomainAdminBinding,
} from "../index.js";

const temporaryDirectories: string[] = [];

function context(projectId: string, overrides: Partial<AdminOperationContext> = {}): AdminOperationContext {
  return {
    scope: {
      installationId: "installation_1",
      workspaceId: "workspace_1",
      projectId,
      environmentId: "environment_1",
      namespace: "tenant_1",
      region: "in-south",
    },
    actor: { id: "operator_1", type: "user", permissions: ["*"] },
    requestId: crypto.randomUUID(),
    correlationId: "correlation_1",
    source: "console",
    ...overrides,
  };
}

function testAdapter(projectId: string): TestFrameworkAdapter {
  return {
    name: `memory-${projectId}`,
    supports: () => true,
    async discover(): Promise<TestCase[]> {
      return [{ id: `test-${projectId}`, file: `${projectId}.test.ts`, name: "scope test" }];
    },
    async run(tests: TestCase[]): Promise<TestResult[]> {
      return tests.map((test) => ({
        id: test.id,
        status: "passed",
        duration: 12,
        artifacts: [{
          type: "log",
          path: `/private/${projectId}.log`,
          buffer: Buffer.from("operator secret"),
        }],
      }));
    },
  };
}

function domainBinding(projectId: string): TestFnDomainAdminBinding {
  const root = mkdtempSync(join(tmpdir(), `testfn-admin-${projectId}-`));
  temporaryDirectories.push(root);
  const runner = new TestRunner({ framework: "vitest", parallel: 1, reporters: [] });
  runner.setAdapter(testAdapter(projectId));
  return {
    runner,
    storage: new TestStorage({ type: "indexeddb", dbName: `testfn-admin-${projectId}-${crypto.randomUUID()}` }),
    visual: new VisualTester({ baselineDir: join(root, "baselines"), diffDir: join(root, "diffs") }),
    environment: { platform: "test", ci: true },
  };
}

function dispatcher(bindings: Map<string, TestFnDomainAdminBinding>) {
  const adapter = createTestFnDomainAdminAdapter({
    resolve: (adminContext) => {
      const binding = bindings.get(adminContext.scope.projectId ?? "");
      if (!binding) throw new Error("missing test binding");
      return binding;
    },
  });
  return createAdminDispatcher({
    registry: createAdminRegistry({ adapters: [adapter], enabledModules: ["testfn"] }),
    audit: new MemoryAdminAuditSink(),
    idempotency: new MemoryAdminIdempotencyStore(),
    confirmation: { verify: ({ token }) => token === "confirmed" },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("@testfn/admin", () => {
  it("publishes only operations backed by public TestFn services", () => {
    expect(testFnAdminResources.map((resource) => resource.id)).toEqual([
      "runs",
      "artifacts",
      "analytics",
      "visual-diffs",
      "visual-baselines",
    ]);
    expect(testFnAdminCapability.operations).toHaveLength(12);
    expect(testFnAdminCapability.operations.every((operation) => operation.minimumScope === "project")).toBe(true);
    expect(testFnAdminCapability.operations.some((operation) => operation.id.includes("suites"))).toBe(false);
    expect(testFnAdminCapability.operations.some((operation) => operation.id.includes("schedules"))).toBe(false);
    expect(testFnAdminCapability.operations.some((operation) => operation.id.includes("agents"))).toBe(false);
    expect(testFnAdminCapability.operations.some((operation) => operation.id.includes("environments"))).toBe(false);

    expect(testFnAdminCapability.operations.find(
      (operation) => operation.id === "testfn.runs.start",
    )?.safety).toMatchObject({ classification: "write", idempotent: false, audit: "required" });
    expect(testFnAdminCapability.operations.find(
      (operation) => operation.id === "testfn.visual-baselines.update",
    )?.safety).toMatchObject({
      classification: "destructive",
      requiresConfirmation: true,
      confirmation: { risk: "critical", method: "mfa" },
    });
    expect(testFnAdminCapability.operations.find(
      (operation) => operation.id === "testfn.visual-diffs.compare",
    )?.redaction?.inputFields).toContain("screenshotBase64");
  });

  it("preserves the receiver for class-style administration services", async () => {
    const binding = domainBinding("project_1");
    const service = createTestFnDomainAdminService({ resolve: async () => binding });
    const original = service.listRuns;
    service.listRuns = async function (input, operationContext) {
      expect(this).toBe(service);
      return original.call(this, input, operationContext);
    };

    await expect(createTestFnAdminAdapter(service).invoke("testfn.runs.list", {}, context("project_1")))
      .resolves.toMatchObject({ data: { items: [] } });
  });

  it("runs, persists, reads, and analyzes through real TestFn APIs without crossing projects", async () => {
    const bindings = new Map([
      ["project_1", domainBinding("project_1")],
      ["project_2", domainBinding("project_2")],
    ]);
    const dispatch = dispatcher(bindings);

    const started = await dispatch.dispatch<{ item: { id: string; results: Array<{ id: string }> } }>({
      operationId: "testfn.runs.start",
      input: {},
      context: context("project_1"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.item.results).toEqual([
      expect.objectContaining({
        id: "test-project_1",
        hasError: false,
        artifactTypes: ["log"],
      }),
    ]);
    expect(JSON.stringify(started.data)).not.toContain("/private/");
    expect(JSON.stringify(started.data)).not.toContain("operator secret");

    const artifact = await dispatch.dispatch({
      operationId: "testfn.artifacts.get",
      input: { id: `${started.data.item.id}-test-project_1-log` },
      context: context("project_1"),
    });
    expect(artifact).toMatchObject({
      ok: true,
      data: { item: { type: "log", available: true } },
    });
    expect(JSON.stringify(artifact)).not.toContain("/private/");
    expect(JSON.stringify(artifact)).not.toContain("operator secret");

    const runsOne = await dispatch.dispatch<{ items: Array<{ id: string }> }>({
      operationId: "testfn.runs.list",
      input: { limit: 25 },
      context: context("project_1"),
    });
    const runsTwo = await dispatch.dispatch<{ items: Array<{ id: string }> }>({
      operationId: "testfn.runs.list",
      input: { limit: 25 },
      context: context("project_2"),
    });
    expect(runsOne.ok && runsOne.data.items.map((run) => run.id)).toContain(started.data.item.id);
    expect(runsTwo.ok && runsTwo.data.items).toEqual([]);

    const metrics = await dispatch.dispatch<{ item: { id: string; successRate: number } }>({
      operationId: "testfn.analytics.metrics",
      input: { id: started.data.item.id },
      context: context("project_1"),
    });
    expect(metrics).toMatchObject({
      ok: true,
      data: { item: { id: started.data.item.id, successRate: 1 } },
    });
  });

  it("rejects a domain object reused across project scopes", async () => {
    const shared = domainBinding("shared");
    const dispatch = dispatcher(new Map([
      ["project_1", shared],
      ["project_2", shared],
    ]));

    await dispatch.dispatch({
      operationId: "testfn.runs.list",
      input: {},
      context: context("project_1"),
    });
    const leaked = await dispatch.dispatch({
      operationId: "testfn.runs.list",
      input: {},
      context: context("project_2"),
    });
    expect(leaked).toMatchObject({
      ok: false,
      error: { code: "precondition_failed" },
    });
  });

  it("updates and compares a real scope-owned visual baseline", async () => {
    const dispatch = dispatcher(new Map([["project_1", domainBinding("project_1")]]));
    const screenshotBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    const updated = await dispatch.dispatch({
      operationId: "testfn.visual-baselines.update",
      input: { id: "home", screenshotBase64, reason: "approved rendering" },
      context: context("project_1", {
        idempotencyKey: "baseline_1",
        confirmationToken: "confirmed",
      }),
    });
    expect(updated).toMatchObject({ ok: true, data: { accepted: true } });

    const comparison = await dispatch.dispatch({
      operationId: "testfn.visual-diffs.compare",
      input: { id: "home", screenshotBase64 },
      context: context("project_1", { idempotencyKey: "compare_1" }),
    });
    expect(comparison).toMatchObject({
      ok: true,
      data: {
        item: {
          id: "home",
          passed: true,
          similarity: 1,
          pixelDiffCount: 0,
        },
      },
    });
  });

  it("requires confirmation for retention cleanup", async () => {
    const dispatch = dispatcher(new Map([["project_1", domainBinding("project_1")]]));
    const denied = await dispatch.dispatch({
      operationId: "testfn.runs.cleanup",
      input: { id: "expired", reason: "retention policy" },
      context: context("project_1", { idempotencyKey: "cleanup_1" }),
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "precondition_failed" } });

    const accepted = await dispatch.dispatch({
      operationId: "testfn.runs.cleanup",
      input: { id: "expired", reason: "retention policy" },
      context: context("project_1", {
        idempotencyKey: "cleanup_2",
        confirmationToken: "confirmed",
      }),
    });
    expect(accepted).toMatchObject({ ok: true, data: { accepted: true } });
  });
});
