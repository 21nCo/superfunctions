import {
  createAdminClient,
  validateAdminCapabilityManifest,
} from "@superfunctions/admin";
import {
  MemoryUserFnOperatorStore,
  UserFnOperatorService,
} from "userfn/operator";
import { describe, expect, it, vi } from "vitest";
import {
  createUserFnAdminAdapter,
  createUserFnAdminClient,
  createUserFnOperatorAdminService,
  userFnAdminCapability,
} from "../index.js";
const scope = {
  installationId: "installation_1",
  workspaceId: "workspace_1",
  projectId: "project_1",
  environmentId: "production",
};
const context = {
  scope,
  actor: { id: "operator_1", permissions: ["*"] },
  requestId: "request_1",
  source: "console" as const,
  idempotencyKey: "idem_1",
  confirmationToken: "confirmed",
};
describe("@userfn/admin", () => {
  it("publishes real engagement resources as a required product", () => {
    expect(validateAdminCapabilityManifest(userFnAdminCapability)).toEqual([]);
    expect(userFnAdminCapability.availability).toBe("required-product");
    expect(userFnAdminCapability.resources.map((item) => item.id)).toEqual([
      "users",
      "segments",
      "flags",
      "campaigns",
      "surveys",
      "feedback",
    ]);
    expect(userFnAdminCapability.operations).toHaveLength(15);
    expect(
      userFnAdminCapability.operations
        .filter((item) => item.safety.classification !== "read")
        .every(
          (item) =>
            item.safety.audit === "required" &&
            item.minimumScope === "environment",
        ),
    ).toBe(true);
  });
  it("updates domain models through the injected self-hosted store", async () => {
    const store = new MemoryUserFnOperatorStore();
    await store.putUser(scope, {
      id: "user_1",
      traits: { email: "alice@example.test", plan: "free" },
    });
    await store.putFlag(scope, {
      key: "new-ui",
      variations: [],
      defaultValue: false,
      rules: [],
      enabled: false,
    });
    const adapter = createUserFnAdminAdapter(
      createUserFnOperatorAdminService(new UserFnOperatorService(store)),
    );
    await expect(
      adapter.invoke(
        "userfn.users.update-traits",
        { id: "user_1", traits: { plan: "pro" } },
        context,
      ),
    ).resolves.toMatchObject({ data: { item: { traits: { plan: "pro" } } } });
    await expect(
      adapter.invoke(
        "userfn.flags.set-enabled",
        { id: "new-ui", enabled: true },
        context,
      ),
    ).resolves.toMatchObject({ data: { item: { enabled: true } } });
  });
  it("isolates records by installation, workspace, project, and environment", async () => {
    const store = new MemoryUserFnOperatorStore();
    const other = { ...scope, workspaceId: "workspace_2" };
    await store.putUser(scope, { id: "same", traits: { name: "one" } });
    await store.putUser(other, { id: "same", traits: { name: "two" } });
    const adapter = createUserFnAdminAdapter(
      createUserFnOperatorAdminService(new UserFnOperatorService(store)),
    );
    await expect(
      adapter.invoke("userfn.users.get", { id: "same" }, context),
    ).resolves.toMatchObject({ data: { item: { traits: { name: "one" } } } });
    await expect(
      adapter.invoke(
        "userfn.users.get",
        { id: "same" },
        { ...context, scope: other },
      ),
    ).resolves.toMatchObject({ data: { item: { traits: { name: "two" } } } });
  });
  it("does not alias scope components that contain separators", async () => {
    const store = new MemoryUserFnOperatorStore();
    const first = { ...scope, installationId: "installation/a", workspaceId: "workspace" };
    const second = { ...scope, installationId: "installation", workspaceId: "a/workspace" };
    await store.putUser(first, { id: "same", traits: { owner: "first" } });
    await store.putUser(second, { id: "same", traits: { owner: "second" } });
    await expect(store.getUser(first, "same")).resolves.toMatchObject({ traits: { owner: "first" } });
    await expect(store.getUser(second, "same")).resolves.toMatchObject({ traits: { owner: "second" } });
  });
  it("paginates all handlers with scope-bound cursors", async () => {
    const store = new MemoryUserFnOperatorStore();
    for (let index = 0; index < 3; index++)
      await store.putUser(scope, {
        id: `user_${index}`,
        traits: { name: `User ${index}` },
      });
    const adapter = createUserFnAdminAdapter(
      createUserFnOperatorAdminService(new UserFnOperatorService(store)),
    );
    expect(Object.keys(adapter.handlers).sort()).toEqual(
      userFnAdminCapability.operations.map((item) => item.id).sort(),
    );
    const first = await adapter.invoke<{
      items: unknown[];
      nextCursor: string;
    }>("userfn.users.list", { limit: 2 }, context);
    expect(first.data.items).toHaveLength(2);
    const second = await adapter.invoke<{ items: unknown[]; nextCursor: null }>(
      "userfn.users.list",
      { limit: 2, cursor: first.data.nextCursor },
      context,
    );
    expect(second.data.items).toHaveLength(1);
    await expect(
      adapter.invoke(
        "userfn.users.list",
        { cursor: first.data.nextCursor },
        { ...context, scope: { ...scope, projectId: "project_2" } },
      ),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
  it("preserves common and named typed SDK methods", () => {
    const client = createUserFnAdminClient(
      createAdminClient({
        baseUrl: "http://admin.test",
        fetch: vi.fn() as never,
      }),
    );
    expect(client).toMatchObject({
      manifest: userFnAdminCapability,
      operations: expect.any(Object),
      availability: expect.any(Function),
      invoke: expect.any(Function),
      pages: expect.any(Function),
      users: { updateTraits: expect.any(Function) },
      flags: { setEnabled: expect.any(Function) },
      segments: { save: expect.any(Function) },
      campaigns: { save: expect.any(Function) },
      surveys: { save: expect.any(Function) },
      feedback: { triage: expect.any(Function) },
    });
    expect("execute" in client).toBe(false);
  });
});
