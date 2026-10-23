import type { ContentfnEnvelope } from "@contentfn/core";
import { ok } from "@contentfn/core";
import { nowISO } from "../../time/clock.js";
import type { ContentfnLimits } from "../../limits/limits.js";

export interface StatusEndpointsConfig {
  limits: ContentfnLimits;
  realtimeEnabled?: boolean;
  /** Only the server invoke boundary supplies durable actor-bound publish replay. */
  publishIdempotency?: boolean;
}

export interface StatusResult {
  serverTime: string;
  capabilities: string[];
  limits: ContentfnLimits;
}

export function handleStatus(
  config: StatusEndpointsConfig
): ContentfnEnvelope<StatusResult> {
  const capabilities = [
    "content.schema",
    "content.docs",
    "content.assets",
    "content.webhooks",
    "content.audit",
  ];

  if (config.publishIdempotency === true) capabilities.push("content.docs.publish.idempotency.v1");

  if (config.realtimeEnabled !== false) {
    capabilities.push("content.realtime");
  }

  return ok({
    serverTime: nowISO(),
    capabilities,
    limits: config.limits,
  });
}
