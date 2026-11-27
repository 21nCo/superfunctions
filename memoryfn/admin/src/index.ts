export * from './types.js';
export * from './capability.js';
export * from './adapter.js';
export * from './client.js';
export * from './domain-service.js';

import type { AdminCapabilityAdapter } from '@superfunctions/admin';
import { createMemoryFnAdminAdapter } from './adapter.js';
import { memoryFnAdminCapability } from './capability.js';
import { createMemoryFnDomainAdminService } from './domain-service.js';
import type { MemoryFnDomainAdminServiceOptions } from './types.js';

/** Creates an environment-scoped adapter backed by a configured MemoryFn runtime. */
export function createMemoryFnDomainAdminAdapter(
  options: MemoryFnDomainAdminServiceOptions,
): AdminCapabilityAdapter<typeof memoryFnAdminCapability> {
  return createMemoryFnAdminAdapter(createMemoryFnDomainAdminService(options));
}

export const adminCapability = memoryFnAdminCapability;
