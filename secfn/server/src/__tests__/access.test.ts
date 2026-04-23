import { describe, expect, it } from "vitest";
import { AccessService, matchesPermission } from "../access.js";
import { MemoryAdapter } from "./memory-adapter.js";

describe("AccessService", () => {
  it("matches colon-delimited wildcards", () => {
    expect(matchesPermission("secfn:secrets:*", "secfn:secrets:rotate")).toBe(true);
    expect(matchesPermission("secfn:*:read", "secfn:secrets:read")).toBe(true);
    expect(matchesPermission("datafn:seed", "datafn:seed")).toBe(true);
    expect(matchesPermission("secfn:secrets:read", "secfn:service-tokens:read")).toBe(false);
  });

  it("honors tenant/resource filters and expired bindings", async () => {
    const access = new AccessService(new MemoryAdapter(), 0);
    const role = await access.createRole({
      name: "secret-admin",
      permissions: ["secfn:secrets:*"],
    });
    await access.assignRole({
      principalId: "user-1",
      roleId: role.id,
      tenantId: "tenant-a",
      resourceId: "secret:one",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await access.assignRole({
      principalId: "user-2",
      roleId: role.id,
      tenantId: "tenant-a",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await expect(access.check({
      principalId: "user-1",
      action: "secfn:secrets:rotate",
      tenantId: "tenant-a",
      resourceId: "secret:one",
    })).resolves.toBe(true);
    await expect(access.check({
      principalId: "user-1",
      action: "secfn:secrets:rotate",
      tenantId: "tenant-b",
      resourceId: "secret:one",
    })).resolves.toBe(false);
    await expect(access.check({
      principalId: "user-2",
      action: "secfn:secrets:rotate",
      tenantId: "tenant-a",
    })).resolves.toBe(false);
  });
});
