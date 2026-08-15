import {
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  type AdminCapabilityAdapter,
  type AdminOperationContext,
  type AdminOperationRequest,
} from "@superfunctions/admin";
import { browseFnAdminCapability } from "./capability.js";
import type { BrowseFnAdminService } from "./types.js";

function bind<TInput, TOutput>(
  receiver: BrowseFnAdminService,
  handler: (input: TInput, context: AdminOperationContext) => Promise<TOutput>,
) {
  return ({ input, context }: AdminOperationRequest) => handler.call(receiver, input as TInput, context);
}

/** Maps every manifest operation to one explicit, typed BrowseFn admin method. */
export function createBrowseFnAdminAdapter(
  service: BrowseFnAdminService,
): AdminCapabilityAdapter<typeof browseFnAdminCapability> {
  return createKernelAdminCapabilityAdapter(browseFnAdminCapability, {
    "browsefn.providers.list": bind(service, service.listProviders),
    "browsefn.metrics.get": bind(service, service.getMetrics),
    "browsefn.metrics.clear": bind(service, service.clearMetrics),
    "browsefn.rate-limits.get": bind(service, service.getRateLimit),
    "browsefn.logs.list": bind(service, service.listLogs),
    "browsefn.logs.clear": bind(service, service.clearLogs),
    "browsefn.cache.get": bind(service, service.getCache),
    "browsefn.cache.clear": bind(service, service.clearCache),
  });
}

export const createAdminAdapter = createBrowseFnAdminAdapter;
