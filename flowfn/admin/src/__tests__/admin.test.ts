import { afterEach, describe, expect, it, vi } from "vitest";
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
  it('operates registered workflows, streams and durable schedules with scope and confirmation checks', async () => {
    const { flow, dispatch } = deployment();
    const workflow = flow.workflow('approval').waitForEvent('ready').waitForApproval('ops', { timeout: 5000 }).build();
    const execution = await workflow.execute({ secret: 'hidden' });
    await flow.stream('updates').publish({ secret: 'stream-data' });
    await flow.scheduler().schedule('daily', { every: 100000 }, async () => {});
    expect(await dispatch.dispatch({ operationId: 'flowfn.workflows.list', input: {}, context: context() })).toMatchObject({ ok: true, data: { items: [{ id: workflow.id, name: 'approval' }] } });
    const fetched = await dispatch.dispatch<{ item: Record<string, unknown> }>({ operationId: 'flowfn.workflow-executions.get', input: { workflowId: workflow.id, id: execution.id }, context: context() });
    expect(fetched.ok).toBe(true);
    if (fetched.ok) { expect(fetched.data.item.input).toBe('[REDACTED]'); expect(fetched.data.item).not.toHaveProperty('lease'); }
    expect(await dispatch.dispatch({ operationId: 'flowfn.streams.get', input: { id: 'updates' }, context: context() })).toMatchObject({ ok: true, data: { item: { id: 'updates', length: 1 } } });
    const mutation = context({ idempotencyKey: 'signal', confirmationToken: 'confirmed' });
    expect(await dispatch.dispatch({ operationId: 'flowfn.workflow-executions.signal', input: { workflowId: workflow.id, id: execution.id, event: 'ready', data: 'payload' }, context: mutation })).toMatchObject({ ok: true });
    await vi.waitFor(async () => expect((await workflow.getExecution(execution.id)).waiting?.kind).toBe('approval'));
    expect(await dispatch.dispatch({ operationId: 'flowfn.workflow-executions.approve', input: { workflowId: workflow.id, id: execution.id, decision: { approved: true, approver: 'ops' } }, context: context({ idempotencyKey: 'approve', confirmationToken: 'confirmed' }) })).toMatchObject({ ok: true });
    expect(await workflow.waitForCompletion(execution.id)).toMatchObject({ status: 'completed', output: { reviewedBy: 'operator_1' } });
    expect(await dispatch.dispatch({ operationId: 'flowfn.schedules.pause', input: { id: 'daily' }, context: context({ idempotencyKey: 'unconfirmed' }) })).toMatchObject({ ok: false });
    expect(await dispatch.dispatch({ operationId: 'flowfn.schedules.pause', input: { id: 'daily' }, context: context({ idempotencyKey: 'pause', confirmationToken: 'confirmed' }) })).toMatchObject({ ok: true });
    expect(await dispatch.dispatch({ operationId: 'flowfn.schedules.list', input: {}, context: context() })).toMatchObject({ ok: true, data: { items: [{ id: 'daily', paused: true }] } });
    expect(await dispatch.dispatch({ operationId: 'flowfn.streams.get', input: { id: 'outside' }, context: context() })).toMatchObject({ ok: false });
  });
  it('returns usable continuation cursors for collections and filtered events', async () => {
    const { flow, events, dispatch } = deployment();
    flow.queue('a'); flow.queue('b');
    const first = await dispatch.dispatch<{ items: Array<{ id: string }>; nextCursor: string | null }>({ operationId: 'flowfn.queues.list', input: { limit: 2 }, context: context() });
    expect(first).toMatchObject({ ok: true, data: { items: [{ id: 'a' }, { id: 'b' }], nextCursor: '2' } });
    const second = await dispatch.dispatch({ operationId: 'flowfn.queues.list', input: { limit: 2, cursor: '2' }, context: context() });
    expect(second).toMatchObject({ ok: true, data: { items: [{ id: 'emails' }], nextCursor: null } });
    for (let i = 0; i < 3; i++) await events.append({ type: 'sent', aggregateId: 'one', aggregateType: 'mail', data: { i } });
    const eventPage = await dispatch.dispatch({ operationId: 'flowfn.events.list', input: { aggregateId: 'one', limit: 2 }, context: context() });
    expect(eventPage).toMatchObject({ ok: true, data: { nextCursor: '2' } });
    const finalEvents = await dispatch.dispatch<{ items: unknown[]; nextCursor: string | null }>({ operationId: 'flowfn.events.list', input: { aggregateId: 'one', limit: 2, cursor: '2' }, context: context() });
    expect(finalEvents.ok).toBe(true);
    if (finalEvents.ok) { expect(finalEvents.data.items).toHaveLength(1); expect(finalEvents.data.nextCursor).toBeNull(); }
    expect(await dispatch.dispatch({ operationId: 'flowfn.queues.list', input: { cursor: '2', offset: 1 }, context: context() })).toMatchObject({ ok: false });
  });
  it('serializes active deduplicated jobs without exposing ownership tokens', async () => {
    const { queue, dispatch } = deployment();
    const job = await queue.add('active', { value: 1 }, { preventDuplicates: true });
    let release!: () => void, started!: () => void;
    const active = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    queue.process(async () => { started(); await blocked; });
    try {
      await active;
      expect((await queue.getJob(job.id))?.lease?.token).toBeTruthy();
      const result = await dispatch.dispatch<{ item: Record<string, unknown> }>({ operationId: 'flowfn.jobs.get', input: { queue: 'emails', id: job.id }, context: context() });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.item.state).toBe('active');
        expect(result.data.item).not.toHaveProperty('lease');
        expect(result.data.item).not.toHaveProperty('deduplicationId');
      }
    } finally { release(); await queue.drain(); }
  });
  it("publishes the environment-backed runtime capabilities", () => {
    expect(validateAdminCapabilityManifest(flowFnAdminCapability)).toEqual([]);
    expect(flowFnAdminResources.map((resource) => resource.id)).toEqual([
      "workflows", "workflow-executions", "streams", "schedules",
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
    expect(flowFnAdminCapability.operations).toHaveLength(31);
    expect(
      flowFnAdminCapability.operations.every(
        (operation) => operation.minimumScope === "environment",
      ),
    ).toBe(true);
    expect(
      flowFnAdminCapability.operations.some((operation) =>
        operation.id.includes("workflows"),
      ),
    ).toBe(true);
    expect(
      flowFnAdminCapability.operations.some((operation) =>
        operation.id.includes("streams"),
      ),
    ).toBe(true);
    expect(
      flowFnAdminCapability.operations.some((operation) =>
        operation.id.includes("consumers"),
      ),
    ).toBe(false);
    expect(
      flowFnAdminCapability.operations.some((operation) =>
        operation.id.includes("schedules"),
      ),
    ).toBe(true);
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
