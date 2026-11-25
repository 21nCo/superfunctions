/**
 * DFN-07: principal membership and hierarchy are resolved per request.
 * A cache kept on the query handler would keep serving a revoked grant.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createDatafnServer } from "../src/server.js";
import type { DatafnSchema } from "../src/core-types.js";

const NAMESPACE = "org:acme";

const schema: DatafnSchema = {
  resources: [
    {
      name: "notes",
      version: 1,
      capabilities: [
        "timestamps",
        "audit",
        { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } },
      ] as any,
      fields: [{ name: "title", type: "string", required: true }],
    },
  ],
  relations: [],
};

async function createHarness() {
  const db = memoryAdapter();
  await db.initialize?.();
  const server = await createDatafnServer({
    allowUnknownResources: true,
    schema,
    database: db,
    namespaceProvider: {
      getNamespace: () => NAMESPACE,
      getActorId: () => "bob" as any,
    },
  });
  const request = { resource: "notes", version: 1, operation: "find", select: ["id", "title"] };
  const send = (body: unknown) => server.router.handle(
    new Request("http://localhost/datafn/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    {},
  );
  const query = async () => {
    const res = await send(request);
    const body = await res.json() as any;
    const ids = (body.result?.data ?? []).map((row: { id: string }) => row.id).sort();
    return { status: res.status, ok: body.ok, ids };
  };
  const batchQuery = () => send([request, request, request]);
  return { db, server, query, batchQuery };
}

describe("query principal freshness", () => {
  let server: { close?: () => Promise<void> } | undefined;
  afterEach(async () => {
    await server?.close?.();
  });

  it("drops a team grant on the next read after the membership is revoked", async () => {
    const harness = await createHarness();
    server = harness.server;
    await harness.db.create({
      model: "notes",
      data: { id: "note_shared", title: "Shared", createdBy: "alice", __ns: NAMESPACE },
      namespace: NAMESPACE,
    });
    await harness.db.create({
      model: "notes",
      data: { id: "note_own", title: "Own", createdBy: "bob", __ns: NAMESPACE },
      namespace: NAMESPACE,
    });
    await harness.db.create({
      model: "__datafn_principal_memberships",
      data: {
        id: "m_bob",
        namespace: NAMESPACE,
        actorId: "bob",
        principalId: "team:eng",
        revokedAt: null,
        __ns: NAMESPACE,
      },
      namespace: NAMESPACE,
    });
    await harness.db.create({
      model: "__datafn_permissions_global",
      data: {
        id: "g_shared",
        resourceType: "notes",
        resourceNs: NAMESPACE,
        resourceId: "note_shared",
        principalId: "team:eng",
        level: "viewer",
        grantKind: "record",
        sourceRef: null,
        grantedBy: "alice",
        grantedAt: 1,
        revokedAt: null,
        __ns: NAMESPACE,
      },
      namespace: NAMESPACE,
    });

    const findMany = vi.spyOn(harness.db, "findMany");
    const first = await harness.batchQuery();
    expect(first.status).toBe(200);
    const batch = await first.json();
    expect(batch.result).toHaveLength(3);
    for (const result of batch.result) {
      expect(result.data.map((row: { id: string }) => row.id).sort()).toEqual(["note_own", "note_shared"]);
    }
    expect(findMany.mock.calls.filter(([params]) => params.model === "__datafn_principal_memberships")).toHaveLength(1);
    expect(findMany.mock.calls.filter(([params]) => params.model === "__datafn_principal_hierarchy")).toHaveLength(1);

    await harness.db.update({
      model: "__datafn_principal_memberships",
      where: [{ field: "id", operator: "eq", value: "m_bob" }],
      data: { revokedAt: 1 },
      namespace: NAMESPACE,
    });

    const second = await harness.query();
    expect(second.status).toBe(200);
    expect(second.ids).toEqual(["note_own"]);
  });

  it("drops a parent-principal grant on the next read after the hierarchy edge is revoked", async () => {
    const harness = await createHarness();
    server = harness.server;
    await harness.db.create({
      model: "notes",
      data: { id: "note_shared", title: "Shared", createdBy: "alice", __ns: NAMESPACE },
      namespace: NAMESPACE,
    });
    await harness.db.create({
      model: "notes",
      data: { id: "note_own", title: "Own", createdBy: "bob", __ns: NAMESPACE },
      namespace: NAMESPACE,
    });
    await harness.db.create({
      model: "__datafn_principal_memberships",
      data: {
        id: "m_bob",
        namespace: NAMESPACE,
        actorId: "bob",
        principalId: "team:eng",
        revokedAt: null,
        __ns: NAMESPACE,
      },
      namespace: NAMESPACE,
    });
    await harness.db.create({
      model: "__datafn_principal_hierarchy",
      data: {
        id: "h_eng",
        namespace: NAMESPACE,
        principalId: "team:eng",
        parentPrincipalId: "org:wide",
        revokedAt: null,
        __ns: NAMESPACE,
      },
      namespace: NAMESPACE,
    });
    await harness.db.create({
      model: "__datafn_permissions_global",
      data: {
        id: "g_wide",
        resourceType: "notes",
        resourceNs: NAMESPACE,
        resourceId: "note_shared",
        principalId: "org:wide",
        level: "viewer",
        grantKind: "record",
        sourceRef: null,
        grantedBy: "alice",
        grantedAt: 1,
        revokedAt: null,
        __ns: NAMESPACE,
      },
      namespace: NAMESPACE,
    });

    const first = await harness.query();
    expect(first.status).toBe(200);
    expect(first.ids).toEqual(["note_own", "note_shared"]);

    await harness.db.update({
      model: "__datafn_principal_hierarchy",
      where: [{ field: "id", operator: "eq", value: "h_eng" }],
      data: { revokedAt: 1 },
      namespace: NAMESPACE,
    });

    const second = await harness.query();
    expect(second.status).toBe(200);
    expect(second.ids).toEqual(["note_own"]);
  });
});
