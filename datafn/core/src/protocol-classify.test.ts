import { describe, expect, it } from "vitest";
import { classifyTransactStep } from "./protocol.js";

describe("classifyTransactStep", () => {
  it("treats a bare mutation and a wrapped mutation as the same kind", () => {
    const body = { resource: "items", operation: "insert", id: 42, record: { name: "x" } };
    const bare = classifyTransactStep(body);
    const wrapped = classifyTransactStep({ mutation: body });
    expect(bare).toEqual({ ok: true, kind: "mutation", body, pathSuffix: "" });
    expect(wrapped).toEqual({ ok: true, kind: "mutation", body, pathSuffix: ".mutation" });
  });

  it("treats a bare resource without an operation as a query", () => {
    const step = { resource: "items" };
    expect(classifyTransactStep(step)).toEqual({
      ok: true,
      kind: "query",
      body: step,
      pathSuffix: "",
    });
  });

  it("rejects a step that sets both query and mutation", () => {
    expect(classifyTransactStep({
      query: { resource: "items" },
      mutation: { resource: "items", operation: "insert", id: "i1" },
    })).toEqual({ ok: false, message: "Invalid DFQL: step must be a query or mutation" });
  });
});
