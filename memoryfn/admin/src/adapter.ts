import {
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  type AdminCapabilityAdapter,
  type AdminOperationContext,
  type AdminOperationRequest,
} from '@superfunctions/admin';
import { memoryFnAdminCapability } from './capability.js';
import type { MemoryFnAdminService } from './types.js';

function bind<TInput, TOutput>(
  handler: (input: TInput, context: AdminOperationContext) => Promise<TOutput>,
) {
  return ({ input, context }: AdminOperationRequest) => handler(input as TInput, context);
}

/** Maps every declared MemoryFn operation to an explicit typed domain method. */
export function createMemoryFnAdminAdapter(
  service: MemoryFnAdminService,
): AdminCapabilityAdapter<typeof memoryFnAdminCapability> {
  return createKernelAdminCapabilityAdapter(memoryFnAdminCapability, {
    'memoryfn.memories.search': bind(service.searchMemories),
    'memoryfn.memories.ingest': bind(service.ingestMemory),
  });
}

export const createAdminAdapter = createMemoryFnAdminAdapter;
