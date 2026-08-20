import { describe, expect, it } from "vitest";
import { buildSchemaIndex } from "../schema.js";

describe("server validation schema index capability fields", () => {
  it("includes capability-injected fields when present on the validated schema", () => {
    const schema = {
      resources: [
        {
          name: "todos",
          version: 1,
          fields: [
            { name: "text", type: "string" as const, required: true },
            { name: "createdAt", type: "date" as const, required: false, readonly: true },
            { name: "updatedAt", type: "date" as const, required: false, readonly: true },
            { name: "trashedAt", type: "date" as const, required: false, readonly: true },
            { name: "trashedBy", type: "string" as const, required: false, readonly: true },
          ],
        },
      ],
    };

    const index = buildSchemaIndex(schema);
    const fields = index.fieldsByResource.get("todos");
    const writable = index.writableFieldsByResource.get("todos");

    expect(fields?.has("createdAt")).toBe(true);
    expect(fields?.has("updatedAt")).toBe(true);
    expect(fields?.has("trashedAt")).toBe(true);
    expect(fields?.has("trashedBy")).toBe(true);
    expect(fields?.has("text")).toBe(true);

    expect(writable?.has("createdAt")).toBe(false);
    expect(writable?.has("updatedAt")).toBe(false);
    expect(writable?.has("trashedAt")).toBe(false);
    expect(writable?.has("trashedBy")).toBe(false);
    expect(writable?.has("text")).toBe(true);
  });

  it("derives a many-one FK from the target when aliases are omitted", () => {
    const index = buildSchemaIndex({
      resources: [
        {
          name: "todos",
          version: 1,
          fields: [{ name: "text", type: "string", required: true }],
        },
        {
          name: "projects",
          version: 1,
          fields: [{ name: "title", type: "string", required: true }],
        },
      ],
      relations: [{
        type: "many-one",
        from: "todos",
        to: "projects",
      }],
    } as any);

    expect(index.fieldsByResource.get("todos")?.has("projectsId")).toBe(true);
    expect(index.writableFieldsByResource.get("todos")?.has("projectsId"))
      .toBe(true);
    expect(index.fieldsByResource.get("todos")?.has("undefinedId")).toBe(false);
  });
});
