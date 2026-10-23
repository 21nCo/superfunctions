export * from "./types.js";
export * from "./capability.js";
export * from "./adapter.js";
export * from "./client.js";
export * from "./domain-service.js";

import type { AdminCapabilityAdapter } from "@superfunctions/admin";
import { createTestFnAdminAdapter } from "./adapter.js";
import { testFnAdminCapability } from "./capability.js";
import { createTestFnDomainAdminService } from "./domain-service.js";
import type { TestFnDomainAdminServiceOptions } from "./types.js";

/** Creates an adapter backed only by scope-bound public TestFn services. */
export function createTestFnDomainAdminAdapter(
  options: TestFnDomainAdminServiceOptions,
): AdminCapabilityAdapter<typeof testFnAdminCapability> {
  return createTestFnAdminAdapter(createTestFnDomainAdminService(options));
}

export const adminCapability = testFnAdminCapability;
