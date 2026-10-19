import { describe, expect, it } from "vitest";
import { validateCmsfnRole } from "./validate.js";
import { evaluatePermission, evaluatePermissions } from "./evaluate.js";
import type { CmsfnRole, CmsfnPermissionInput } from "./types.js";

const rule = { datasets: ["prod"], types: ["post"], actions: ["doc.read"] };
const role = { id: "editor", name: "Editor", rules: [rule] };
const input: CmsfnPermissionInput = { dataset: "prod", type: "post", action: "doc.read" };

describe("untrusted role validation", () => {
  it.each([
    null, [], { ...role, id: 12 }, { ...role, rules: "*" },
    { ...role, rules: [null] }, { ...role, rules: [[]] },
    { ...role, rules: [{ ...rule, datasets: "production" }] },
    { ...role, rules: [{ ...rule, types: "postscript" }] },
    { ...role, rules: [{ ...rule, actions: "doc.read.extra" }] },
    { ...role, rules: [{ ...rule, datasets: ["prod", null] }] },
    { ...role, rules: [{ ...rule, types: ["post", {}] }] },
    { ...role, rules: [{ ...rule, actions: ["doc.read", "admin"] }] },
    { ...role, rules: [{ ...rule, actions: ["*"] }] },
    { ...role, rules: [{ ...rule, actions: ["toString"] }] },
    { ...role, rules: [{ ...rule, datasets: [" "] }] },
    { ...role, rules: [{ ...rule, types: [""] }] },
    { ...role, rules: new Array(1) },
    { ...role, rules: [{ ...rule, actions: new Array(1) }] },
  ])("rejects malformed roles without authorizing", value => {
    expect(validateCmsfnRole(value).ok).toBe(false);
    expect(evaluatePermission(value as CmsfnRole, input)).toBe(false);
  });
  it("rejects an entire malformed role even when an earlier rule permits", () => {
    expect(evaluatePermission({ ...role, rules: [rule, { ...rule, actions: ["unknown"] }] } as CmsfnRole, input)).toBe(false);
  });
  it("does not invoke inherited selectors or accessor properties", () => {
    const inherited = Object.create(rule);
    expect(validateCmsfnRole({ ...role, rules: [inherited] }).ok).toBe(false);
    const getter = { ...rule, get datasets() { throw new Error("must not run"); } };
    expect(validateCmsfnRole({ ...role, rules: [getter] }).ok).toBe(false);
  });
  it("preserves wildcards, empty deny lists, exact selectors and valid action names", () => {
    expect(evaluatePermission({ ...role, rules: [{ datasets: "*", types: "*", actions: "*" }] }, input)).toBe(true);
    expect(evaluatePermission({ ...role, rules: [{ ...rule, actions: [] }] } as CmsfnRole, input)).toBe(false);
    expect(evaluatePermission({ ...role, rules: [{ ...rule, datasets: ["production"] }] } as CmsfnRole, input)).toBe(false);
    expect(evaluatePermissions([null, role] as CmsfnRole[], input)).toBe(true);
    expect(evaluatePermissions(null as unknown as CmsfnRole[], input)).toBe(false);
    expect(evaluatePermission({ ...role, rules: [{ datasets: "*", types: "*", actions: "*" }] }, { ...input, action: "unknown" } as unknown as CmsfnPermissionInput)).toBe(false);
  });
  it("returns a detached canonical role without widening whitespace selectors", () => {
    const original = { ...role, id: " editor ", rules: [{ ...rule, datasets: [" prod "] }] };
    const validated = validateCmsfnRole(original);
    if (!validated.ok) throw new Error("valid role rejected");
    original.rules[0].datasets.push("prod");
    expect(validated.role.id).toBe("editor");
    expect(evaluatePermission(validated.role, input)).toBe(false);
  });
});
