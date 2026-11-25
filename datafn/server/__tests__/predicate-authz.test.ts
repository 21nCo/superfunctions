/**
 * DFN-09: relation filters and mutation guards use the related field's read policy.
 */
import { afterEach, describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createDatafnServer } from "../src/server.js";
import type { DatafnSchema } from "../src/core-types.js";

const NAMESPACE = "datafn";

const schema: DatafnSchema = {
  resources: [
    {
      name: "people",
      version: 1,
      fields: [
        { name: "name", type: "string", required: true },
        { name: "employerId", type: "string", required: false },
        { name: "secret", type: "string", required: false },
      ],
      permissions: {
        read: { fields: ["name", "employerId"] },
        write: { fields: ["name", "employerId"] },
      },
    },
    {
      name: "employers",
      version: 1,
      fields: [
        { name: "name", type: "string", required: true },
        { name: "taxId", type: "string", required: false },
      ],
      permissions: {
        read: { fields: ["name"] },
        write: { fields: ["name"] },
      },
    },
  ],
  relations: [
    {
      from: "people",
      to: "employers",
      type: "many-one" as const,
      relation: "employer",
      inverse: "staff",
      fkField: "employerId",
    },
  ],
};

async function createHarness(
  serverSchema = schema,
  personFields: Record<string, unknown> = {},
  allowUnknownResources = false,
) {
  const db = memoryAdapter();
  await db.initialize?.();
  await db.create({
    model: "employers",
    data: { id: "emp_1", name: "Acme", taxId: "test-tax-id", __ns: NAMESPACE },
    namespace: NAMESPACE,
  });
  await db.create({
    model: "people",
    data: {
      id: "per_1",
      name: "Ada",
      employerId: "emp_1",
      secret: "test-secret-field",
      __ns: NAMESPACE,
      ...personFields,
    },
    namespace: NAMESPACE,
  });
  const server = await createDatafnServer({
    schema: serverSchema,
    database: db,
    allowUnknownResources,
    namespaceProvider: {
      getNamespace: () => NAMESPACE,
      getActorId: () => "ada" as any,
    },
  });
  const post = async (path: string, body: unknown) => {
    const res = await server.router.handle(
      new Request(`http://localhost/datafn/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      {},
    );
    return { status: res.status, body: await res.json() as any };
  };
  return { db, server, post };
}

describe("predicate field authorization", () => {
  let server: { close?: () => Promise<void> } | undefined;
  afterEach(async () => {
    await server?.close?.();
  });

  it("allows a readable relation dot-path and denies an unreadable one", async () => {
    const harness = await createHarness();
    server = harness.server;
    const allowed = await harness.post("query", {
      resource: "people",
      version: 1,
      select: ["id", "name"],
      filters: { "employer.name": "Acme" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.result.data.map((row: { id: string }) => row.id)).toEqual(["per_1"]);

    const denied = await harness.post("query", {
      resource: "people",
      version: 1,
      select: ["id", "name"],
      filters: { "employer.taxId": "test-tax-id" },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");
    expect(denied.body.error.message).toBe("Authorization denied");
  });

  it("allows a readable quantifier filter and denies an unreadable one", async () => {
    const harness = await createHarness();
    server = harness.server;
    const allowed = await harness.post("query", {
      resource: "people",
      version: 1,
      select: ["id", "name"],
      filters: { employer: { $any: { name: "Acme" } } },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.result.data.map((row: { id: string }) => row.id)).toEqual(["per_1"]);

    const denied = await harness.post("query", {
      resource: "people",
      version: 1,
      select: ["id", "name"],
      filters: { employer: { $any: { taxId: "test-tax-id" } } },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");
    expect(denied.body.error.message).toBe("Authorization denied");
  });

  it("filters a readable object field whose name is also a relation", async () => {
    const [people, employers] = schema.resources;
    const harness = await createHarness({
      ...schema,
      resources: [{
        ...people,
        fields: [...people.fields, { name: "employer", type: "object", required: false }],
        permissions: {
          ...people.permissions,
          read: { fields: [...(people.permissions?.read?.fields ?? []), "employer"] },
        },
      }, employers],
    }, { employer: { city: "Pune" } });
    server = harness.server;
    const result = await harness.post("query", {
      resource: "people",
      version: 1,
      select: ["id"],
      filters: { "employer.city": "Pune" },
    });
    expect(result.status).toBe(200);
    expect(result.body.result.data).toEqual([{ id: "per_1" }]);
  });

  it("uses the related resource to resolve each hop of a dot-path", async () => {
    const harness = await createHarness();
    server = harness.server;
    const result = await harness.post("query", {
      resource: "people",
      version: 1,
      select: ["id"],
      filters: { "employer.staff.name": "Ada" },
    });
    expect(result.status).toBe(200);
    expect(result.body.result.data).toEqual([{ id: "per_1" }]);
  });

  it("matches a readable implicit foreign key on a related resource", async () => {
    const [people, employers] = schema.resources;
    const harness = await createHarness({
      ...schema,
      resources: [{ ...people, fields: people.fields.filter((field) => field.name !== "employerId") }, employers],
    });
    server = harness.server;
    const result = await harness.post("query", {
      resource: "people",
      version: 1,
      select: ["id"],
      filters: { "employer.staff.employerId": "emp_1" },
    });
    expect(result.status).toBe(200);
    expect(result.body.result.data).toEqual([{ id: "per_1" }]);
  });

  it("checks read access to an implicit foreign key named like an inverse relation", async () => {
    const [, employers] = schema.resources;
    const harness = await createHarness({
      ...schema,
      resources: [...schema.resources, { ...employers, name: "cooperatives" }],
      relations: [{
        type: "one-many",
        from: ["employers", "cooperatives"],
        to: "people",
        relation: "workers",
        inverse: "workplace",
        fkField: "workplace",
      }],
    }, { workplace: "emp_1", workplaceResource: "employers" });
    server = harness.server;
    const result = await harness.post("query", {
      resource: "people",
      version: 1,
      select: ["id"],
      filters: { workplace: { $any: { name: "Acme" } } },
    });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("FORBIDDEN");
  });

  it("checks the source FK policy for a dedicated relation's default selection", async () => {
    const harness = await createHarness({
      ...schema,
      relations: [{ ...schema.relations![0], fkField: "employer" }],
    }, { employer: "emp_1" });
    server = harness.server;
    const result = await harness.post("query", {
      resource: "people", version: 1, relation: "employer", id: "per_1",
    });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("FORBIDDEN");
  });

  it("authorizes transact query fields against the resource that the step projects", async () => {
    const [people, employers] = schema.resources;
    const harness = await createHarness({
      ...schema,
      resources: [people, {
        ...employers,
        fields: [...employers.fields, { name: "secret", type: "string", required: false }],
        permissions: { ...employers.permissions, read: { fields: ["name", "secret"] } },
      }],
    });
    server = harness.server;
    const result = await harness.post("transact", { steps: [{ query: {
      resource: "people", version: 1, relation: "employer", id: "per_1", select: ["secret"],
    } }] });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("FORBIDDEN");
  });

  it("authorizes a HAVING alias by its computed source instead of the same-named column", async () => {
    const [people, employers] = schema.resources;
    const harness = await createHarness({
      ...schema,
      resources: [{
        ...people,
        fields: people.fields.filter((field) => field.name !== "employerId"),
        permissions: { ...people.permissions, read: { fields: ["name"] } },
      }, employers],
    });
    server = harness.server;
    const result = await harness.post("query", {
      resource: "people",
      version: 1,
      groupBy: ["name"],
      aggregations: { employerId: { op: "count", field: "*" } },
      having: { employerId: { gt: 0 } },
    });
    expect(result.status).toBe(200);
    expect(result.body.result.groups).toEqual([{ name: "Ada", employerId: 1 }]);
  });

  it("keeps explicit target permissions when the root resource has no policy", async () => {
    const [people, employers] = schema.resources;
    const harness = await createHarness({
      ...schema,
      resources: [{ ...people, permissions: undefined }, employers],
    }, {}, true);
    server = harness.server;

    const query = { resource: "people", version: 1, select: ["id"] };
    const allowed = await harness.post("query", { ...query, filters: { "employer.name": "Acme" } });
    const denied = await harness.post("query", { ...query, filters: { "employer.taxId": "test-tax-id" } });
    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
  });

  it("allows a readable guard and rejects an unreadable guard before the write", async () => {
    const harness = await createHarness();
    server = harness.server;
    const denied = await harness.post("mutation", {
      resource: "people",
      version: 1,
      operation: "merge",
      id: "per_1",
      record: { name: "should-not-apply" },
      if: { secret: "test-secret-field" },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");
    expect(denied.body.error.path ?? denied.body.error.details?.path).toContain("secret");

    const storedAfterDeny = await harness.db.findOne({
      model: "people",
      where: [{ field: "id", operator: "eq", value: "per_1" }],
      namespace: NAMESPACE,
    });
    expect(storedAfterDeny.name).toBe("Ada");

    const allowed = await harness.post("mutation", {
      resource: "people",
      version: 1,
      operation: "merge",
      id: "per_1",
      record: { name: "Ada updated" },
      if: { name: "Ada" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.ok).toBe(true);

    const stored = await harness.db.findOne({
      model: "people",
      where: [{ field: "id", operator: "eq", value: "per_1" }],
      namespace: NAMESPACE,
    });
    expect(stored.name).toBe("Ada updated");
  });
});
