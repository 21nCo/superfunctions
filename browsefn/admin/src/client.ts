import {
  createCapabilityAdminClient,
  type AdminClient,
  type AdminClientRequestOptions,
} from "@superfunctions/admin";
import { browseFnAdminCapability } from "./capability.js";
import type {
  BrowseFnClearCacheInput,
  BrowseFnClearLogsInput,
  BrowseFnClearMetricsInput,
  BrowseFnGetMetricsInput,
  BrowseFnGetRateLimitInput,
  BrowseFnListLogsInput,
} from "./types.js";

/** Function-scoped TypeScript client with named methods for every BrowseFn operation. */
export function createBrowseFnAdminClient(adminClient: AdminClient) {
  const client = createCapabilityAdminClient(browseFnAdminCapability, adminClient);
  return Object.assign(client, {
    providers: {
      list: (options?: AdminClientRequestOptions) => client.invoke("browsefn.providers.list", {}, options),
    },
    metrics: {
      get: (input: BrowseFnGetMetricsInput = {}, options?: AdminClientRequestOptions) => client.invoke("browsefn.metrics.get", input, options),
      clear: (input: BrowseFnClearMetricsInput, options?: AdminClientRequestOptions) => client.invoke("browsefn.metrics.clear", input, options),
    },
    rateLimits: {
      get: (input: BrowseFnGetRateLimitInput, options?: AdminClientRequestOptions) => client.invoke("browsefn.rate-limits.get", input, options),
    },
    logs: {
      list: (input: BrowseFnListLogsInput = {}, options?: AdminClientRequestOptions) => client.invoke("browsefn.logs.list", input, options),
      clear: (input: BrowseFnClearLogsInput, options?: AdminClientRequestOptions) => client.invoke("browsefn.logs.clear", input, options),
    },
    cache: {
      get: (options?: AdminClientRequestOptions) => client.invoke("browsefn.cache.get", {}, options),
      clear: (input: BrowseFnClearCacheInput, options?: AdminClientRequestOptions) => client.invoke("browsefn.cache.clear", input, options),
    },
  });
}
