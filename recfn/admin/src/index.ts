export * from "./types.js";
export * from "./capability.js";
export * from "./adapter.js";
export * from "./client.js";
export * from "./domain-service.js";

import type { AdminCapabilityAdapter } from "@superfunctions/admin";
import { createRecFnAdminAdapter } from "./adapter.js";
import { recFnAdminCapability } from "./capability.js";
import { createRecFnDomainAdminService } from "./domain-service.js";
import type { RecFnDomainAdminServiceOptions } from "./types.js";

/** Creates a complete project-scoped adapter backed by RecFn's public server. */
export function createRecFnDomainAdminAdapter(
  options: RecFnDomainAdminServiceOptions,
): AdminCapabilityAdapter<typeof recFnAdminCapability> {
  return createRecFnAdminAdapter(createRecFnDomainAdminService(options));
}

export const adminCapability = recFnAdminCapability;
