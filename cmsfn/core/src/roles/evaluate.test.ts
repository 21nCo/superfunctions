import { describe, it, expect } from "vitest";
import { evaluatePermission, evaluatePermissions } from "./evaluate.js";
import type { CmsfnRole } from "./types.js";

describe("evaluatePermission", () => {
  it("allows when single rule matches dataset, type, and action", () => {
    const role: CmsfnRole = {
      id: "r1",
      name: "Editor",
      rules: [
        {
          datasets: ["prod"],
          types: ["post"],
          actions: ["doc.read", "doc.patch"],
        },
      ],
    };
    expect(
      evaluatePermission(role, { dataset: "prod", type: "post", action: "doc.read" })
    ).toBe(true);
    expect(
      evaluatePermission(role, { dataset: "prod", type: "post", action: "doc.patch" })
    ).toBe(true);
  });

  it("denies when dataset does not match", () => {
    const role: CmsfnRole = {
      id: "r1",
      name: "Editor",
      rules: [
        { datasets: ["prod"], types: ["post"], actions: ["doc.read"] },
      ],
    };
    expect(
      evaluatePermission(role, { dataset: "staging", type: "post", action: "doc.read" })
    ).toBe(false);
  });

  it("denies when type does not match", () => {
    const role: CmsfnRole = {
      id: "r1",
      name: "Editor",
      rules: [
        { datasets: ["prod"], types: ["post"], actions: ["doc.read"] },
      ],
    };
    expect(
      evaluatePermission(role, { dataset: "prod", type: "page", action: "doc.read" })
    ).toBe(false);
  });

  it("denies when action does not match", () => {
    const role: CmsfnRole = {
      id: "r1",
      name: "Editor",
      rules: [
        { datasets: ["prod"], types: ["post"], actions: ["doc.read"] },
      ],
    };
    expect(
      evaluatePermission(role, { dataset: "prod", type: "post", action: "doc.publish" })
    ).toBe(false);
  });

  it("allows when rule uses wildcard datasets", () => {
    const role: CmsfnRole = {
      id: "r1",
      name: "Admin",
      rules: [
        { datasets: "*", types: ["post"], actions: ["doc.read"] },
      ],
    };
    expect(
      evaluatePermission(role, { dataset: "prod", type: "post", action: "doc.read" })
    ).toBe(true);
    expect(
      evaluatePermission(role, { dataset: "staging", type: "post", action: "doc.read" })
    ).toBe(true);
  });

  it("allows when rule uses wildcard types and actions", () => {
    const role: CmsfnRole = {
      id: "r1",
      name: "Admin",
      rules: [
        { datasets: ["prod"], types: "*", actions: "*" },
      ],
    };
    expect(
      evaluatePermission(role, { dataset: "prod", type: "post", action: "doc.publish" })
    ).toBe(true);
  });

  it("is deterministic when multiple rules match (first matching rule permits)", () => {
    const role: CmsfnRole = {
      id: "r1",
      name: "Multi",
      rules: [
        { datasets: ["prod"], types: ["post"], actions: ["doc.read"] },
        { datasets: ["prod"], types: ["post"], actions: ["doc.patch"] },
      ],
    };
    expect(
      evaluatePermission(role, { dataset: "prod", type: "post", action: "doc.read" })
    ).toBe(true);
    expect(
      evaluatePermission(role, { dataset: "prod", type: "post", action: "doc.patch" })
    ).toBe(true);
  });

  it("denies when no rules match", () => {
    const role: CmsfnRole = {
      id: "r1",
      name: "Limited",
      rules: [
        { datasets: ["prod"], types: ["post"], actions: ["doc.read"] },
      ],
    };
    expect(
      evaluatePermission(role, { dataset: "prod", type: "post", action: "doc.delete" })
    ).toBe(false);
  });

  it("denies when role has empty rules", () => {
    const role: CmsfnRole = {
      id: "r1",
      name: "Empty",
      rules: [],
    };
    expect(
      evaluatePermission(role, { dataset: "prod", type: "post", action: "doc.read" })
    ).toBe(false);
  });
});

describe("evaluatePermissions (multiple roles)", () => {
  it("allows when any role permits", () => {
    const roles: CmsfnRole[] = [
      {
        id: "r1",
        name: "A",
        rules: [{ datasets: ["staging"], types: ["post"], actions: ["doc.read"] }],
      },
      {
        id: "r2",
        name: "B",
        rules: [{ datasets: ["prod"], types: ["post"], actions: ["doc.read"] }],
      },
    ];
    expect(
      evaluatePermissions(roles, { dataset: "prod", type: "post", action: "doc.read" })
    ).toBe(true);
    expect(
      evaluatePermissions(roles, { dataset: "staging", type: "post", action: "doc.read" })
    ).toBe(true);
  });

  it("denies when no role permits", () => {
    const roles: CmsfnRole[] = [
      {
        id: "r1",
        name: "A",
        rules: [{ datasets: ["staging"], types: ["post"], actions: ["doc.read"] }],
      },
    ];
    expect(
      evaluatePermissions(roles, { dataset: "prod", type: "post", action: "doc.read" })
    ).toBe(false);
  });

  it("is deterministic with role order (first permitting role wins)", () => {
    const roles: CmsfnRole[] = [
      {
        id: "r1",
        name: "First",
        rules: [{ datasets: ["prod"], types: ["post"], actions: ["doc.read"] }],
      },
      {
        id: "r2",
        name: "Second",
        rules: [{ datasets: ["prod"], types: ["post"], actions: ["doc.read"] }],
      },
    ];
    expect(
      evaluatePermissions(roles, { dataset: "prod", type: "post", action: "doc.read" })
    ).toBe(true);
  });
});
