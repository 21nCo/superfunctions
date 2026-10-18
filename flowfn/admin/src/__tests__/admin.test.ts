import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryDLQManager,
  MemoryEventLog,
  MemoryJobStorage,
  createFlow,
  createWorker,
  type FlowFn,
} from "@flowfn/core";
import {
  MemoryAdminAuditSink,
  MemoryAdminIdempotencyStore,
  createAdminDispatcher,
  createAdminRegistry,
  type AdminOperationContext,
  validateAdminCapabilityManifest,
} from "@superfunctions/admin";
import {
  createFlowFnDomainAdminAdapter,
  createFlowFnAdminAdapter,
  createFlowFnDomainAdminService,
  flowFnAdminCapability,
  flowFnAdminResources,
} from "../index.js";

const flows: FlowFn[] = [];

function context(
  overrides: Partial<AdminOperationContext> = {},
): AdminOperationContext {
  return {
    scope: {
      installationId: "installation_1",
      workspaceId: "workspace_1",
      projectId: "project_1",
      environmentId: "environment_1",
      namespace: "tenant_1",
    },
    actor: { id: "operator_1", type: "user", permissions: ["*"] },
    requestId: `request_${crypto.randomUUID()}`,
    correlationId: "correlation_1",
    source: "console",
    ...overrides,
  };
}

function deployment() {
  const flow = createFlow({ adapter: "memory", namespace: "tenant_1" });
  flows.push(flow);
  const jobs = new MemoryJobStorage();
  const dlq = new MemoryDLQManager();
  const events = new MemoryEventLog();
  const queue = flow.queue("emails");
  const worker = createWorker({ flow, queues: ["emails"], concurrency: 1 });
  const adapter = createFlowFnDomainAdminAdapter({
    flow,
    jobs,
    dlq,
    events,
    workers: [{ id: "worker_1", worker, queues: ["emails"] }],
    installationId: "installation_1",
    workspaceId: "workspace_1",
    projectId: "project_1",
    environmentId: "environment_1",
    namespace: "tenant_1",
  });
  const audit = new MemoryAdminAuditSink();
  const dispatch = createAdminDispatcher({
    registry: createAdminRegistry({
      adapters: [adapter],
      enabledModules: ["flowfn"],
    }),
    audit,
    idempotency: new MemoryAdminIdempotencyStore(),
    confirmation: { verify: ({ token }) => token === "confirmed" },
  });
  return { flow, jobs, dlq, events, queue, worker, audit, dispatch };
}

afterEach(async () => {
  await Promise.all(flows.splice(0).map((flow) => flow.close()));
});

describe("@flowfn/admin", () => {
  it("publishes only the real environment-backed FlowFn subset", () => {
    expect(validateAdminCapabilityManifest(flowFnAdminCapability)).toEqual([]);
    expect(flowFnAdminResources.map((resource) => resource.id)).toEqual([
      "queues",
      "jobs",
      "workers",
      "dead-letters",
      "events",
    ]);
    expect(flowFnAdminCapability.scopeLevels).toEqual([
      "installation",
      "workspace",
      "project",
      "environment",
    ]);
    expect(flowFnAdminCapability.operations).toHaveLength(17);
    expect(
      flowFnAdminCapability.operations.every(
        (operation) => operation.minimumScope === "environment",
      ),
    ).toBe(true);
    expect(
      flowFnAdminCapability.operations.some((operation) =>
        operation.id.includes("workflows"),
      ),
    ).toBe(false);
    expect(
      flowFnAdminCapability.operations.some((operation) =>
        operation.id.includes("streams"),
      ),
    ).toBe(false);
    expect(
      flowFnAdminCapability.operations.some((operation) =>
        operation.id.includes("consumers"),
      ),
    ).toBe(false);
    expect(
      flowFnAdminCapability.operations.some((operation) =>
        operation.id.includes("schedules"),
      ),
    ).toBe(false);
    expect(
      flowFnAdminCapability.operations.some(
        (operation) => operation.inputSchema?.properties?.payload,
      ),
    ).toBe(false);

    expect(
      flowFnAdminCapability.operations.find(
        (operation) => operation.id === "flowfn.jobs.enqueue",
      )?.inputSchema?.required,
    ).toEqual(["queue", "name", "data"]);
    expect(
      flowFnAdminCapability.operations.find(
        (operation) => operation.id === "flowfn.dead-letters.redrive",
      )?.safety,
    ).toMatchObject({
      classification: "write",
      requiresConfirmation: true,
      confirmation: { method: "recent-auth", risk: "high" },
    });
    expect(
      flowFnAdminCapability.operations.find(
        (operation) => operation.id === "flowfn.dead-letters.delete",
      )?.safety,
    ).toMatchObject({
      classification: "destructive",
      confirmation: { method: "mfa", risk: "critical" },
    });
  });

  it("preserves the receiver for class-style administration services", async () => {
    const { flow, jobs, dlq, events, worker } = deployment();
    const base = createFlowFnDomainAdminService({
      flow,
      jobs,
      dlq,
      events,
      workers: [{ id: "worker_1", worker, queues: ["emails"] }],
      installationId: "installation_1",
      workspaceId: "workspace_1",
      projectId: "project_1",
      environmentId: "environment_1",
      namespace: "tenant_1",
    });
    const original = base.listQueues;
    base.listQueues = async function (input, operationContext) {
      expect(this).toBe(base);
      return original.call(this, input, operationContext);
    };

    await expect(
      createFlowFnAdminAdapter(base).invoke(
        "flowfn.queues.list",
        {},
        context(),
      ),
    ).resolves.toMatchObject({ data: { items: [{ id: "emails" }] } });
  });

  it("uses real createFlow, Queue, JobStorage, Worker, and EventLog contracts", async () => {
    const { dispatch, jobs, events, audit } = deployment();

    await events.append({
      type: "email.requested",
      aggregateId: "campaign_1",
      aggregateType: "campaign",
      data: { recipient: "private@example.com", apiKey: "private-key" },
      metadata: { trace: "private-trace" },
    });

    const queues = await dispatch.dispatch({
      operationId: "flowfn.queues.list",
      input: {},
      context: context(),
    });
    expect(queues).toMatchObject({
      ok: true,
      data: { items: [{ id: "emails", name: "emails" }], nextCursor: null },
    });

    const enqueued = await dispatch.dispatch<{
      item: { id: string; data: unknown };
    }>({
      operationId: "flowfn.jobs.enqueue",
      input: {
        queue: "emails",
        name: "deliver",
        data: { to: "private@example.com", apiKey: "private-key" },
      },
      context: context({
        idempotencyKey: "job_campaign_1",
        confirmationToken: "confirmed",
      }),
    });
    expect(enqueued).toMatchObject({
      ok: true,
      data: {
        item: {
          id: "job_campaign_1",
          queue: "emails",
          data: "[REDACTED]",
          state: "waiting",
        },
      },
    });
    expect(await jobs.get("emails", "job_campaign_1")).toMatchObject({
      data: { to: "private@example.com", apiKey: "private-key" },
    });

    const listedJobs = await dispatch.dispatch({
      operationId: "flowfn.jobs.list",
      input: { queue: "emails", status: "waiting" },
      context: context(),
    });
    expect(listedJobs).toMatchObject({
      ok: true,
      data: { items: [{ id: "job_campaign_1", data: "[REDACTED]" }] },
    });

    const workers = await dispatch.dispatch({
      operationId: "flowfn.workers.list",
      input: {},
      context: context(),
    });
    expect(workers).toMatchObject({
      ok: true,
      data: { items: [{ id: "worker_1", queues: ["emails"] }] },
    });
    expect(
      await dispatch.dispatch({
        operationId: "flowfn.workers.run",
        input: { id: "worker_1" },
        context: context({
          idempotencyKey: "run_worker_1",
          confirmationToken: "confirmed",
        }),
      }),
    ).toMatchObject({ ok: true, data: { accepted: true } });

    const listedEvents = await dispatch.dispatch({
      operationId: "flowfn.events.list",
      input: { aggregateId: "campaign_1" },
      context: context(),
    });
    expect(listedEvents).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            type: "email.requested",
            data: "[REDACTED]",
            metadata: "[REDACTED]",
          },
        ],
      },
    });
    expect(
      audit.events.find((event) => event.operationId === "flowfn.jobs.enqueue")
        ?.input,
    ).toMatchObject({ data: "[REDACTED]" });
  });

  it("redrives through the real DLQ, Queue, and JobStorage with confirmation", async () => {
    const { dispatch, dlq, queue, jobs } = deployment();
    const failed = await queue.add(
      "emails",
      { authorization: "private-token" },
      { jobId: "failed_1", attempts: 3 },
    );
    await failed.moveToFailed(new Error("provider secret failure"));
    await dlq.moveToDLQ(failed, "provider failed");

    const listed = await dispatch.dispatch({
      operationId: "flowfn.dead-letters.list",
      input: {},
      context: context(),
    });
    expect(listed).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            id: "failed_1",
            originalQueue: "emails",
            data: "[REDACTED]",
            errors: "[REDACTED]",
          },
        ],
      },
    });

    const missingConfirmation = await dispatch.dispatch({
      operationId: "flowfn.dead-letters.redrive",
      input: { id: "failed_1" },
      context: context({ idempotencyKey: "redrive_failed_1" }),
    });
    expect(missingConfirmation).toMatchObject({
      ok: false,
      error: { code: "precondition_failed" },
    });

    const redriven = await dispatch.dispatch({
      operationId: "flowfn.dead-letters.redrive",
      input: { id: "failed_1" },
      context: context({
        idempotencyKey: "redrive_failed_1",
        confirmationToken: "confirmed",
      }),
    });
    expect(redriven).toMatchObject({
      ok: true,
      data: {
        accepted: true,
        item: {
          id: "failed_1",
          queue: "emails",
          data: "[REDACTED]",
          state: "waiting",
        },
      },
    });
    expect(await dlq.getAll()).toEqual([]);
    expect(await jobs.get("emails", "failed_1")).toMatchObject({
      state: "waiting",
    });
  });

  it("reads live worker results rather than the enqueue-time job storage mirror", async () => {
    const { dispatch, queue } = deployment();
    const job = await queue.add("deliver", { secret: "payload" });
    queue.process(async (job) => {
      await job.log("secret log");
      return "secret result";
    });
    await queue.drain();
    expect(
      await dispatch.dispatch({
        operationId: "flowfn.jobs.get",
        input: { queue: "emails", id: job.id },
        context: context(),
      }),
    ).toMatchObject({
      ok: true,
      data: {
        item: {
          state: "completed",
          logs: "[REDACTED]",
          returnvalue: "[REDACTED]",
        },
      },
    });
  });

  it("retains dead-letter evidence when redrive cannot enqueue, and denies unauthorized actors", async () => {
    const { queue, dlq, dispatch } = deployment();
    const failed = await queue.add(
      "deliver",
      { secret: "payload" },
      { jobId: "retain-on-failure" },
    );
    await failed.moveToFailed(new Error("failed"));
    await dlq.moveToDLQ(failed, "failure", "emails");
    expect(
      await dispatch.dispatch({
        operationId: "flowfn.dead-letters.delete",
        input: { id: failed.id, reason: "cleanup" },
        context: context({
          actor: { id: "denied", type: "user", permissions: [] },
          idempotencyKey: "denied",
          confirmationToken: "confirmed",
        }),
      }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await queue.close();
    expect(
      await dispatch.dispatch({
        operationId: "flowfn.dead-letters.redrive",
        input: { id: failed.id },
        context: context({
          idempotencyKey: "failed-redrive",
          confirmationToken: "confirmed",
        }),
      }),
    ).toMatchObject({ ok: false });
    expect(await dlq.getAll()).toHaveLength(1);
    expect((await dlq.getAll())[0].name).toBe("deliver");
  });

  it.each([
    { installationId: "another" },
    { organizationId: "another" },
    { region: "another" },
    { installationId: undefined, organizationId: undefined },
  ])(
    "rejects mismatched installation aliases and region: %j",
    async (scopeOverride) => {
      const { dispatch } = deployment();
      const original = context();
      expect(
        await dispatch.dispatch({
          operationId: "flowfn.queues.list",
          input: {},
          context: context({ scope: { ...original.scope, ...scopeOverride } }),
        }),
      ).toMatchObject({
        ok: false,
        error: {
          code: expect.stringMatching(/^(forbidden|invalid_argument)$/),
        },
      });
    },
  );

  it("accepts the legacy installation alias only when it matches the binding", async () => {
    const { dispatch } = deployment();
    const original = context();
    expect(
      await dispatch.dispatch({
        operationId: "flowfn.queues.list",
        input: {},
        context: context({
          scope: {
            ...original.scope,
            installationId: undefined,
            organizationId: "installation_1",
          },
        }),
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects another environment or namespace before calling FlowFn", async () => {
    const { dispatch } = deployment();
    const wrongEnvironment = await dispatch.dispatch({
      operationId: "flowfn.queues.list",
      input: {},
      context: context({
        scope: {
          installationId: "installation_1",
          workspaceId: "workspace_1",
          projectId: "project_1",
          environmentId: "environment_2",
          namespace: "tenant_1",
        },
      }),
    });
    expect(wrongEnvironment).toMatchObject({
      ok: false,
      error: { code: "forbidden", status: 403 },
    });

    const wrongNamespace = await dispatch.dispatch({
      operationId: "flowfn.queues.list",
      input: {},
      context: context({
        scope: {
          installationId: "installation_1",
          workspaceId: "workspace_1",
          projectId: "project_1",
          environmentId: "environment_1",
          namespace: "tenant_2",
        },
      }),
    });
    expect(wrongNamespace).toMatchObject({
      ok: false,
      error: { code: "forbidden", status: 403 },
    });
  });
});
