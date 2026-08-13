import { describe, expect, it } from "vitest";
import { validateAdminCapabilityManifest } from "@superfunctions/admin";
import { hostFnAdminCapability } from "../index.js";
describe("@hostfn/admin availability", () => {
  it("fails closed until HostFn exposes a reusable deployment control plane", () => {
    expect(validateAdminCapabilityManifest(hostFnAdminCapability)).toEqual([]);
    expect(hostFnAdminCapability).toMatchObject({ availability: "unavailable", operations: [], navigation: [], resources: [] });
    expect(hostFnAdminCapability.unavailableReason).toMatch(/not a canonical reusable server\/operator API/i);
  });
});
