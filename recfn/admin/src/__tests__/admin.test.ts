import { createMemoryStore } from "@recfn/server";
import { describe, expect, it, vi } from "vitest";
import {
  createRecFnDomainAdminAdapter,
  createRecFnDomainAdminService,
  recFnAdminCapability,
} from "../index.js";

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
  confirmationToken: "confirmation_1",
};

const config = {
  displayName: "Recorder",
  joinTimeout: 60_000,
  autoLeaveOnEmpty: true,
  autoLeaveEmptyTimeout: 60_000,
  consentMessage: "This meeting is recorded.",
  enableRealTimeTranscript: false,
  asrProvider: "whisper",
  recordingFormat: "audio_only" as const,
  language: "en-US",
};

describe("@recfn/admin", () => {
  it("publishes only domain-backed operations and exact safety policy", () => {
    const ids = recFnAdminCapability.operations.map((operation) => operation.id);

    expect(ids).toContain("recfn.bots.list");
    expect(ids).toContain("recfn.webhooks.create");
    expect(ids).not.toContain("recfn.recording-bots.schedule-bot");
    expect(ids.some((id) => id.includes("transcribe"))).toBe(false);
    expect(ids.some((id) => id.includes("calendar"))).toBe(false);
    expect(recFnAdminCapability.operations.find((operation) => operation.id === "recfn.bots.delete")?.safety).toMatchObject({
      classification: "destructive",
      requiresConfirmation: true,
      confirmation: { risk: "critical", method: "recent-auth" },
      audit: "required",
    });
  });

  it("executes through the real RecFn server and isolates namespaces", async () => {
    const store = createMemoryStore();
    const visible = await store.createBot({ meetingUrl: "https://meet.google.com/aaa-bbbb-ccc", platform: "meet", config, namespace: "tenant_1" });
    await store.createBot({ meetingUrl: "https://meet.google.com/ddd-eeee-fff", platform: "meet", config, namespace: "tenant_2" });
    const adapter = createRecFnDomainAdminAdapter({ projectId: "project_1", server: { store, environment: "test" } });

    const result = await adapter.execute("recfn.bots.list", { limit: 25 }, context);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      items: [expect.objectContaining({ id: visible.id, namespace: "[REDACTED]", meetingUrl: "[REDACTED]" })],
      nextCursor: null,
    });
  });

  it("uses RecFn webhook validation and never returns the signing secret", async () => {
    const store = createMemoryStore();
    const service = createRecFnDomainAdminService({ projectId: "project_1", server: { store, environment: "test" } });
    const adapter = createRecFnDomainAdminAdapter({ projectId: "project_1", server: { store, environment: "test" } });

    const result = await adapter.execute("recfn.webhooks.create", {
      url: "https://events.example.com/recfn",
      events: ["bot.joined"],
      secret: "do-not-return",
    }, context);
    const created = result.data;
    const listed = await service.listWebhooks({}, context);

    expect(created).toEqual({ item: expect.not.objectContaining({ secret: expect.anything() }) });
    expect(listed.items).toEqual([created.item]);
    await expect(service.createWebhook({ url: "file:///tmp/exfiltrate", events: ["bot.joined"] }, context)).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("rejects a mismatched project before touching the RecFn store", async () => {
    const store = createMemoryStore();
    const service = createRecFnDomainAdminService({ projectId: "project_1", server: { store, environment: "test" } });

    await expect(service.listBots({}, { ...context, scope: { ...context.scope, projectId: "project_2" } })).rejects.toMatchObject({ code: "forbidden" });
    expect((await store.listBots("tenant_1", {})).items).toEqual([]);
  });

  it("deletes only terminal bots through RecFn lifecycle rules", async () => {
    const store = createMemoryStore();
    const bot = await store.createBot({ meetingUrl: "https://meet.google.com/aaa-bbbb-ccc", platform: "meet", config, namespace: "tenant_1" });
    await store.updateBot(bot.id, "tenant_1", { status: "done", updatedAt: new Date().toISOString() });
    const service = createRecFnDomainAdminService({ projectId: "project_1", server: { store, environment: "test" } });

    await expect(service.deleteBot({ botId: bot.id }, context)).resolves.toEqual({ botId: bot.id, deleted: true });
    expect(await store.getBot(bot.id, "tenant_1")).toBeNull();
  });

  it("does not start calendar polling for per-request admin routers", async () => {
    const timer = vi.spyOn(globalThis, "setInterval");
    const service = createRecFnDomainAdminService({
      projectId: "project_1",
      server: {
        store: createMemoryStore(),
        environment: "test",
        tokenStore: {} as never,
        googleCalendarClient: {} as never,
        outlookCalendarClient: {} as never,
        calendarRuntime: { enabled: true, namespaces: ["tenant_1"], pollIntervalMs: 1_000 },
      },
    });

    await expect(service.listBots({}, context)).resolves.toMatchObject({ items: [] });
    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
  });
});
