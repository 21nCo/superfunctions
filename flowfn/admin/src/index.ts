export * from "./types.js";
export * from "./capability.js";
export * from "./adapter.js";
export * from "./client.js";
export * from "./domain-service.js";

import type { AdminCapabilityAdapter } from "@superfunctions/admin";
import { createFlowFnAdminAdapter } from "./adapter.js";
import { flowFnAdminCapability } from "./capability.js";
import { createFlowFnDomainAdminService } from "./domain-service.js";
import type { FlowFnDomainAdminServiceOptions } from "./types.js";

export function createFlowFnDomainAdminAdapter(
  options: FlowFnDomainAdminServiceOptions,
): AdminCapabilityAdapter<typeof flowFnAdminCapability> {
  return createFlowFnAdminAdapter(createFlowFnDomainAdminService(options));
}

export const adminCapability = flowFnAdminCapability;
