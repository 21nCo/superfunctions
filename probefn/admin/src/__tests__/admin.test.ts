import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore } from "@probefn/storage";
import { AdminError, type AdminClient } from "@superfunctions/admin";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProbeFnAdminAdapter,
  createProbeFnAdminClient,
  createProbeFnDomainAdminService,
  probeFnAdminCapability,
} from "../index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const deterministic = {
  enabled: true,
  viewport: { width: 1280, height: 720 },
  locale: "en-US",
  timezone: "UTC",
  colorScheme: "light" as const,
  reducedMotion: "reduce" as const,
  animationPolicy: "freeze" as const,
  networkIdleMs: 500,
};

function context(environmentId: string) {
  return {
    scope: {
      installationId: "installation_1",
      workspaceId: "workspace_1",
      projectId: "project_1",
      environmentId,
      namespace: "tenant_1",
      region: "in-south",
    },
    actor: { id: "operator_1", type: "user" as const, permissions: ["*"] },
    requestId: `request_${environmentId}`,
    correlationId: "correlation_1",
    source: "console" as const,
    idempotencyKey: "idempotency_1",
    confirmationToken: "recent-auth-confirmation",
  };
}

async function projectRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `probefn-admin-${name}-`));
  temporaryRoots.push(root);
  return root;
}

describe("@probefn/admin", () => {
  it("advertises only domain-backed environment operations", () => {
    const operationIds = probeFnAdminCapability.operations.map((operation) => operation.id);

    expect(probeFnAdminCapability.scopeLevels).toEqual([
      "installation",
      "workspace",
      "project",
      "environment",
    ]);
    expect(operationIds).toEqual([
      "probefn.sessions.get",
      "probefn.sessions.initialize",
      "probefn.sessions.mark-running",
      "probefn.sessions.mark-completed",
      "probefn.sessions.mark-failed",
      "probefn.event-deltas.capture-baseline",
      "probefn.event-deltas.diff",
      "probefn.checkpoints.capture",
      "probefn.reports.export",
      "probefn.storage.get-run-paths",
      "probefn.storage.get-checkpoint-paths",
    ]);
    expect(operationIds.some((id) => id.includes("baseline") && !id.includes("capture-baseline"))).toBe(false);
    expect(operationIds.some((id) => id.includes("cloud") || id.includes("cancel-probe"))).toBe(false);
    expect(probeFnAdminCapability.operations.every((operation) => operation.minimumScope === "environment")).toBe(true);

    const capture = probeFnAdminCapability.operations.find(
      (operation) => operation.id === "probefn.checkpoints.capture",
    );
    expect(capture).toMatchObject({
      safety: {
        classification: "write",
        idempotent: false,
        requiresConfirmation: true,
        confirmation: { risk: "high", method: "recent-auth", maxAgeSeconds: 300 },
        audit: "required",
      },
      redaction: {
        outputFields: expect.arrayContaining(["url", "authorization", "cookie", "token"]),
      },
    });
  });

  it("uses real ProbeFn stores, sessions, deltas, checkpoints, and reports without crossing scope", async () => {
    const firstRoot = await projectRoot("first");
    const secondRoot = await projectRoot("second");
    const firstStore = new ArtifactStore({ repoRoot: firstRoot, artifactRoot: ".evidence" });
    const checkpointSource = {
      url: () => "https://example.test/dashboard",
      viewportSize: () => ({ width: 1280, height: 720 }),
      screenshot: async () => new Uint8Array([137, 80, 78, 71]),
      domSnapshot: async () => ({ role: "main", text: "Dashboard" }),
      accessibilitySnapshot: async () => ({ role: "main", name: "Dashboard" }),
      layoutSnapshot: async () => ({ x: 0, y: 0, width: 1280, height: 720 }),
      stylesSnapshot: async () => ({ color: "rgb(0, 0, 0)" }),
    };
    const adapter = createProbeFnAdminAdapter(createProbeFnDomainAdminService({
      bindings: [
        {
          scope: {
            installationId: "installation_1",
            workspaceId: "workspace_1",
            projectId: "project_1",
            environmentId: "environment_1",
            namespace: "tenant_1",
            region: "in-south",
          },
          repoRoot: firstRoot,
          artifactRoot: ".evidence",
          checkpointSource: async () => checkpointSource,
        },
        {
          scope: {
            installationId: "installation_1",
            workspaceId: "workspace_1",
            projectId: "project_1",
            environmentId: "environment_2",
            namespace: "tenant_1",
            region: "in-south",
          },
          repoRoot: secondRoot,
          artifactRoot: ".evidence",
          checkpointSource: async () => checkpointSource,
        },
      ],
    }));

    const initialized = await adapter.execute<{ item: { status: string; artifactRoot: string } }>(
      "probefn.sessions.initialize",
      {
        sessionId: "session_1",
        runId: "run_1",
        mode: "debug",
        browser: "chromium",
        deterministic,
        startedAt: "2026-08-13T00:00:00.000Z",
        resolvedUrl: "https://example.test/dashboard?token=super-secret#fragment",
      },
      context("environment_1"),
    );
    expect(initialized.data.item).toMatchObject({
      status: "starting",
      artifactRoot: ".evidence/runs/run_1",
    });
    const persistedSession = await readFile(
      path.resolve(firstRoot, ".evidence/session-state/session_1.json"),
      "utf8",
    );
    expect(persistedSession).not.toContain("super-secret");
    expect(persistedSession).not.toContain("fragment");

    await expect(
      adapter.execute("probefn.sessions.get", { id: "session_1" }, context("environment_2")),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });

    const runPaths = firstStore.getRunPaths("run_1");
    const consoleSink = firstStore.createEventSink("run_1", "console", "events");
    const pageErrorSink = firstStore.createEventSink("run_1", "page-errors", "events");
    const networkSink = firstStore.createEventSink("run_1", "network", "events");
    await consoleSink.append({ type: "console", level: "error", message: "boom", token: "secret" });
    await pageErrorSink.append({ type: "page-error", message: "boom" });
    await networkSink.append({ type: "network", status: 500 });

    const baseline = await adapter.execute<{
      sessionId: string;
      baseline: { consoleErrors: number; pageErrors: number; networkFailures: number };
    }>(
      "probefn.event-deltas.capture-baseline",
      { sessionId: "session_1" },
      context("environment_1"),
    );
    expect(baseline.data).toEqual({
      sessionId: "session_1",
      baseline: { consoleErrors: 1, pageErrors: 1, networkFailures: 1 },
    });

    await adapter.execute(
      "probefn.sessions.mark-running",
      { id: "session_1" },
      context("environment_1"),
    );
    const checkpoint = await adapter.execute<{
      accepted: true;
      item: { checkpointId: string; artifacts: string[]; newConsoleErrors: number };
    }>(
      "probefn.checkpoints.capture",
      {
        sessionId: "session_1",
        name: "dashboard",
        before: { consoleErrors: 0, pageErrors: 0, networkFailures: 0 },
        includeStyles: true,
      },
      context("environment_1"),
    );
    expect(checkpoint.data).toMatchObject({
      accepted: true,
      item: { checkpointId: "chk_dashboard", newConsoleErrors: 1 },
    });
    expect(checkpoint.data.item.artifacts).toHaveLength(5);

    const storagePaths = await adapter.execute<{ item: { reportJsonPath: string } }>(
      "probefn.storage.get-run-paths",
      { runId: "run_1" },
      context("environment_1"),
    );
    expect(storagePaths.data.item.reportJsonPath).toBe(".evidence/runs/run_1/report.json");

    const report = await adapter.execute<{ accepted: true; reportPath: string; redactedValueCount: number }>(
      "probefn.reports.export",
      { sessionId: "session_1", format: "json" },
      context("environment_1"),
    );
    expect(report.data).toMatchObject({ accepted: true, reportPath: runPaths.reportJsonPath });
    const reportContents = await readFile(path.resolve(firstRoot, report.data.reportPath), "utf8");
    expect(reportContents).not.toContain("secret");

    const completed = await adapter.execute<{ item: { status: string } }>(
      "probefn.sessions.mark-completed",
      { id: "session_1" },
      context("environment_1"),
    );
    expect(completed.data.item.status).toBe("completed");
    await expect(
      adapter.execute("probefn.sessions.mark-failed", { id: "session_1" }, context("environment_1")),
    ).rejects.toBeInstanceOf(AdminError);

    await expect(
      readFile(path.resolve(secondRoot, ".evidence/session-state/session_1.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("provides named typed client methods instead of only a generic invoke escape hatch", async () => {
    const invokeOperation = vi.fn(async () => ({ ok: true as const, data: { item: { status: "running" } } }));
    const client = createProbeFnAdminClient({ invokeOperation } as unknown as AdminClient);

    await client.sessions.get({ id: "session_1" });

    expect(invokeOperation).toHaveBeenCalledWith(
      "probefn.sessions.get",
      { id: "session_1" },
      undefined,
    );
    expect(client.operations["probefn.reports.export"]).toBeTypeOf("function");
  });

  it("rejects ambiguous or shared storage bindings at construction", async () => {
    const root = await projectRoot("shared");
    const checkpointSource = async () => ({
      url: () => "https://example.test",
      viewportSize: () => ({ width: 1, height: 1 }),
      screenshot: async () => new Uint8Array(),
      domSnapshot: async () => ({}),
      accessibilitySnapshot: async () => ({}),
      layoutSnapshot: async () => ({}),
    });

    expect(() => createProbeFnDomainAdminService({
      bindings: [
        {
          scope: {
            installationId: "installation_1",
            workspaceId: "workspace_1",
            projectId: "project_1",
            environmentId: "environment_1",
          },
          repoRoot: root,
          checkpointSource,
        },
        {
          scope: {
            installationId: "installation_1",
            workspaceId: "workspace_1",
            projectId: "project_1",
            environmentId: "environment_2",
          },
          repoRoot: root,
          checkpointSource,
        },
      ],
    })).toThrowError(/may not share/);
  });
});
