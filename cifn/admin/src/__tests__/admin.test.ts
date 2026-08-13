import { createAdminClient } from "@superfunctions/admin";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  MemoryArtifactsAdapter,
  MemoryLogsAdapter,
  MemoryQueueAdapter,
  MemorySecretsAdapter,
} from "@cifn/control-plane";
import {
  ciFnAdminCapability,
  createCiFnAdminAdapter,
  createCiFnAdminClient,
  createCiFnControlPlaneAdminService,
  type CiFnAdminService,
} from "../index.js";

const API_KEY = "cifn-admin-integration-key";
const pipelineSpec = {
  name: "admin integration",
  on: { workflow_dispatch: {} },
  jobs: {
    verify: {
      "runs-on": "default",
      steps: [{ run: "npm test" }],
    },
  },
};

const context = {
  scope: {
    organizationId: "org_1",
    workspaceId: "workspace_1",
    projectId: "project_1",
    environmentId: "environment_1",
    namespace: "tenant_1",
    region: "in-south",
  },
  actor: { id: "operator_1", type: "user" as const, permissions: ["*"] },
  requestId: "request_1",
  correlationId: "correlation_1",
  source: "console" as const,
  idempotencyKey: "idempotency_1",
};

describe("@cifn/admin", () => {
  let artifacts: MemoryArtifactsAdapter;
  let logs: MemoryLogsAdapter;
  let queue: MemoryQueueAdapter;
  let secrets: MemorySecretsAdapter;
  let controlPlane: ReturnType<typeof createApp>;
  let resolveConnection: ReturnType<typeof vi.fn>;
  let forwardedRequests: Request[];
  let service: CiFnAdminService;

  beforeEach(async () => {
    artifacts = new MemoryArtifactsAdapter();
    logs = new MemoryLogsAdapter();
    queue = new MemoryQueueAdapter();
    secrets = new MemorySecretsAdapter();
    await secrets.setSecret("CIFN_API_KEYS", API_KEY);
    controlPlane = createApp({
      adapters: { artifacts, logs, queue, secrets },
      pipelineResolver: async () => ({
        doc: JSON.stringify(pipelineSpec),
        resolvedConfigPath: ".ci/pipeline.json",
      }),
    });
    forwardedRequests = [];
    resolveConnection = vi.fn(async () => ({
      baseUrl: "http://cifn-control-plane.test",
      apiKey: API_KEY,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        forwardedRequests.push(request.clone());
        return controlPlane.app.fetch(request);
      }) as typeof fetch,
    }));
    service = createCiFnControlPlaneAdminService({ resolveConnection });
  });

  it("publishes only real control-plane resources with domain-specific schemas", () => {
    expect(ciFnAdminCapability.resources?.map((resource) => resource.id)).toEqual([
      "runs",
      "jobs",
      "logs",
      "artifacts",
    ]);
    expect(ciFnAdminCapability.operations.map((operation) => operation.id)).toEqual([
      "cifn.runs.list",
      "cifn.runs.get",
      "cifn.jobs.list",
      "cifn.jobs.get",
      "cifn.logs.list",
      "cifn.artifacts.list",
      "cifn.runs.trigger-run",
      "cifn.runs.retry-run",
      "cifn.runs.cancel-run",
      "cifn.artifacts.download-artifact",
    ]);
    expect(ciFnAdminCapability.operations.find((operation) => operation.id === "cifn.runs.trigger-run")).toMatchObject({
      inputSchema: {
        properties: {
          pipelineRef: { required: ["repo", "ref"] },
          pipelineSpec: { type: "object" },
        },
        anyOf: [{ required: ["pipelineRef"] }, { required: ["pipelineSpec"] }],
      },
    });
    expect(ciFnAdminCapability.operations.find((operation) => operation.id === "cifn.runs.cancel-run")).toMatchObject({
      safety: { classification: "destructive", requiresConfirmation: true },
      target: { resource: "runs", idInput: "id" },
    });
    expect(JSON.stringify(ciFnAdminCapability)).not.toContain("unknown");
    expect(JSON.stringify(ciFnAdminCapability)).not.toContain("projects");
    expect(JSON.stringify(ciFnAdminCapability)).not.toContain("retry-job");
  });

  it("executes trigger, list, detail, jobs, logs, artifacts, retry, and cancel against the actual CiFn stack", async () => {
    const adapter = createCiFnAdminAdapter(service);
    const triggered = await adapter.execute<{ runId: string }>(
      "cifn.runs.trigger-run",
      {
        trigger: { type: "workflow_dispatch" },
        pipelineRef: { repo: "21nCo/super-functions", ref: "main" },
      },
      context,
    );
    const runId = triggered.data.runId;
    expect(controlPlane.store.getRun(runId)).toBeDefined();
    expect(queue.size("cifn:jobs")).toBe(1);

    await logs.appendJobLogLine(runId, "verify", {
      line: "actual control-plane output",
      timestamp: "2026-08-13T06:00:00.000Z",
      stepKey: "step-0",
    });
    const fileId = await artifacts.upload(`cifn/${runId}`, "dist.tgz", Buffer.from("artifact"));
    controlPlane.store.addArtifact(runId, { name: "dist.tgz", fileId });

    const listed = await adapter.execute<{ items: Array<{ runId: string }> }>(
      "cifn.runs.list",
      { filter: { status: "queued" }, limit: 10 },
      context,
    );
    expect(listed.data.items.map((run) => run.runId)).toContain(runId);

    const detail = await adapter.execute<{ item: { jobs: Array<{ id: string; jobKey: string }> } }>(
      "cifn.runs.get",
      { id: runId },
      context,
    );
    expect(detail.data.item.jobs[0]).toMatchObject({ jobKey: "verify" });
    expect(detail.data.item.jobs[0]!.id).toContain("::verify");

    const jobs = await adapter.execute<{ items: Array<{ jobKey: string }> }>(
      "cifn.jobs.list",
      { filter: { runId } },
      context,
    );
    expect(jobs.data.items.map((job) => job.jobKey)).toEqual(["verify"]);

    const job = await adapter.execute<{ item: { jobKey: string } }>(
      "cifn.jobs.get",
      { id: detail.data.item.jobs[0]!.id },
      context,
    );
    expect(job.data.item.jobKey).toBe("verify");

    const logResult = await adapter.execute<{ items: Array<{ line: string }>; capabilities: { follow: boolean } }>(
      "cifn.logs.list",
      { filter: { runId, jobKey: "verify" } },
      context,
    );
    expect(logResult.data).toMatchObject({
      items: [{ line: "actual control-plane output" }],
      capabilities: { follow: true },
    });

    const artifactResult = await adapter.execute<{ items: Array<{ fileId: string }> }>(
      "cifn.artifacts.list",
      { filter: { runId } },
      context,
    );
    expect(artifactResult.data.items).toEqual([
      expect.objectContaining({ fileId, name: "dist.tgz", runId }),
    ]);

    const retried = await adapter.execute<{ runId: string; retriedRunId: string }>(
      "cifn.runs.retry-run",
      { id: runId, reason: "verify remediation" },
      context,
    );
    expect(retried.data.retriedRunId).toBe(runId);
    expect(retried.data.runId).not.toBe(runId);
    expect(controlPlane.store.getRun(retried.data.runId)).toBeDefined();

    const cancelled = await adapter.execute<{ runId: string; status: string }>(
      "cifn.runs.cancel-run",
      { id: runId },
      context,
    );
    expect(cancelled.data).toMatchObject({ runId, status: "cancelled" });
    expect(controlPlane.store.getRun(runId)?.status).toBe("cancelled");

    expect(resolveConnection).toHaveBeenCalledWith(expect.objectContaining({
      scope: context.scope,
      actor: context.actor,
      requestId: context.requestId,
    }));
    expect(forwardedRequests[0]!.headers.get("x-cifn-admin-actor-id")).toBe("operator_1");
    expect(forwardedRequests[0]!.headers.get("x-cifn-organization-id")).toBe("org_1");
    expect(forwardedRequests[0]!.headers.get("x-cifn-project-id")).toBe("project_1");
    expect(forwardedRequests[0]!.headers.get("x-request-id")).toBe("request_1");
    expect(forwardedRequests[0]!.headers.get("x-correlation-id")).toBe("correlation_1");
    expect(forwardedRequests[0]!.headers.get("idempotency-key")).toBe("idempotency_1");
  });

  it("does not claim retry or download when the control plane lacks the required retained input", async () => {
    const inline = await service.triggerRun({ pipelineSpec }, context);
    await expect(service.retryRun({ id: inline.runId }, context)).rejects.toMatchObject({
      code: "precondition_failed",
      status: 412,
    });

    const fileId = await artifacts.upload(`cifn/${inline.runId}`, "unsigned.tgz", Buffer.from("artifact"));
    controlPlane.store.addArtifact(inline.runId, { name: "unsigned.tgz", fileId });
    await expect(service.downloadArtifact({ id: fileId, runId: inline.runId }, context)).rejects.toMatchObject({
      code: "precondition_failed",
      status: 412,
    });
  });

  it("returns a signed artifact destination from the configured real artifact boundary", async () => {
    const signedArtifacts = new MemoryArtifactsAdapter();
    signedArtifacts.getSignedUrl = vi.fn(async (fileId) => `https://files.example.test/download/${fileId}?signature=bound`);
    const signedControlPlane = createApp({
      adapters: { artifacts: signedArtifacts, logs, queue, secrets },
      pipelineResolver: async () => ({ doc: JSON.stringify(pipelineSpec), resolvedConfigPath: ".ci/pipeline.json" }),
    });
    const signedService = createCiFnControlPlaneAdminService({
      connection: {
        baseUrl: "http://cifn-control-plane.test",
        apiKey: API_KEY,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
          signedControlPlane.app.fetch(new Request(input, init))) as typeof fetch,
      },
    });
    const run = await signedService.triggerRun({ pipelineSpec }, context);
    const fileId = await signedArtifacts.upload(`cifn/${run.runId}`, "signed.tgz", Buffer.from("artifact"));
    signedControlPlane.store.addArtifact(run.runId, { name: "signed.tgz", fileId });

    await expect(signedService.downloadArtifact({ id: fileId, runId: run.runId }, context)).resolves.toMatchObject({
      artifactId: fileId,
      signedExternal: true,
      downloadUrl: expect.stringMatching(/^https:\/\/files\.example\.test\/download\//),
    });
  });

  it("exposes named, typed SDK methods rather than an unknown execute envelope", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { items: [], nextCursor: null },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createCiFnAdminClient(createAdminClient({
      baseUrl: "https://console.example.test/api/admin/v1",
      fetch: fetcher as typeof fetch,
    }));
    const result = await client.listRuns({ filter: { status: "failure" }, limit: 20 });
    expect(result.data.items).toEqual([]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://console.example.test/api/admin/v1/operations/cifn.runs.list",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ filter: { status: "failure" }, limit: 20 }),
      }),
    );
  });
});
