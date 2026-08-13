import { describe, expect, it } from "vitest";
import { validateAdminCapabilityManifest } from "@superfunctions/admin";
import { userFnAdminCapability } from "../index.js";
describe("@userfn/admin availability", () => {
  it("fails closed until UserFn owns a self-hosted authoritative backend", () => {
    expect(validateAdminCapabilityManifest(userFnAdminCapability)).toEqual([]);
    expect(userFnAdminCapability).toMatchObject({ availability: "unavailable", operations: [], navigation: [], resources: [] });
    expect(userFnAdminCapability.unavailableReason).toMatch(/cannot prove server-side scope or persistence ownership/i);
  });
});
