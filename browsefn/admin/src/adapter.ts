import {
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  type AdminCapabilityAdapter,
  type AdminOperationContext,
  type AdminOperationRequest,
} from "@superfunctions/admin";
import { browseFnAdminCapability } from "./capability.js";
import type { BrowseFnAdminService } from "./types.js";

function bind<TInput, TOutput>(
  handler: (input: TInput, context: AdminOperationContext) => Promise<TOutput>,
) {
  return ({ input, context }: AdminOperationRequest) => handler(input as TInput, context);
}

/** Maps every manifest operation to one explicit, typed BrowseFn admin method. */
export function createBrowseFnAdminAdapter(
  service: BrowseFnAdminService,
): AdminCapabilityAdapter<typeof browseFnAdminCapability> {
  return createKernelAdminCapabilityAdapter(browseFnAdminCapability, {
    "browsefn.providers.list": bind(service.listProviders),
    "browsefn.metrics.get": bind(service.getMetrics),
    "browsefn.metrics.clear": bind(service.clearMetrics),
    "browsefn.rate-limits.get": bind(service.getRateLimit),
    "browsefn.logs.list": bind(service.listLogs),
    "browsefn.logs.clear": bind(service.clearLogs),
    "browsefn.cache.get": bind(service.getCache),
    "browsefn.cache.clear": bind(service.clearCache),
  });
}

export const createAdminAdapter = createBrowseFnAdminAdapter;
