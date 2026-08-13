import { describe, expect, it } from "vitest";
import { validateAdminCapabilityManifest } from "@superfunctions/admin";
import { docsFnAdminCapability } from "../index.js";
describe("@docsfn/admin availability", () => {
  it("fails closed until DocsFn owns site and deployment administration", () => {
    expect(validateAdminCapabilityManifest(docsFnAdminCapability)).toEqual([]);
    expect(docsFnAdminCapability).toMatchObject({ availability: "unavailable", operations: [], navigation: [], resources: [] });
    expect(docsFnAdminCapability.unavailableReason).toMatch(/no canonical site CRUD or deployment control plane/i);
  });
});
