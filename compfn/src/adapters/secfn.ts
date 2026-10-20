/**
 * Secfn evidence adapter: calls secfn (or mock client) for RBAC status, secret-scan
 * summary, or security events; returns AdapterEvidence with type "automated_secfn".
 */

import type { EvidenceAdapter, AdapterCheckInput, AdapterEvidence } from "./types.js";

/**
 * Minimal secfn client interface for the adapter. Implementations may call real secfn
 * APIs; tests can pass a mock that returns fixed data.
 */
export interface SecfnClient {
  getRbacStatus?(options?: { method?: string; customConfig?: Record<string, unknown> }): Promise<{ enabled: boolean; summary?: string }>;
  /** If supplied, status must be completed/success/succeeded/passed to certify findings. */
  getSecretScanSummary?(options?: { method?: string; customConfig?: Record<string, unknown> }): Promise<{ lastScanAt?: number; findings?: number; status?: string }>;
  getSecurityEvents?(options?: { method?: string; customConfig?: Record<string, unknown> }): Promise<{ count?: number; recent?: unknown[] }>;
}

export interface SecfnAdapterConfig {
  /** Secfn client (real or mock). Required for runCheck to produce evidence. */
  client: SecfnClient;
}

const ADAPTER_NAME = "secfn";

/**
 * Secfn evidence adapter. runCheck() calls the configured client (e.g. getRbacStatus,
 * getSecretScanSummary, or getSecurityEvents based on input.method) and maps the
 * result to AdapterEvidence with type "automated_secfn".
 */
export function createSecfnAdapter(config: SecfnAdapterConfig): EvidenceAdapter {
  const { client } = config;

  return {
    name: ADAPTER_NAME,
    async runCheck(input: AdapterCheckInput): Promise<AdapterEvidence> {
      const method = input.method ?? "getRbacStatus";
      const opts = { method: input.method, customConfig: input.customConfig };

      try {
        if (method === "getSecretScanSummary" && client.getSecretScanSummary) {
          const summary = await client.getSecretScanSummary(opts);
          const completed = summary.status === undefined || (typeof summary.status === "string" &&
            ["completed", "success", "succeeded", "passed"].includes(summary.status.trim().toLowerCase()));
          const validCount = typeof summary.findings === "number" && Number.isSafeInteger(summary.findings) && summary.findings >= 0;
          const outcome = !completed || !validCount ? "unknown" : summary.findings === 0 ? "pass" : "fail";
          return {
            type: "automated_secfn",
            outcome,
            timestamp: summary.lastScanAt ?? Date.now(),
            payload: { summary, method },
          };
        }
        if (method === "getSecurityEvents" && client.getSecurityEvents) {
          const events = await client.getSecurityEvents(opts);
          return {
            type: "automated_secfn",
            outcome: "unknown",
            timestamp: Date.now(),
            payload: { count: events.count, method },
          };
        }
        // Default: getRbacStatus
        if (method === "getRbacStatus" && client.getRbacStatus) {
          const rbacResult = await client.getRbacStatus(opts);
          const outcome = rbacResult.enabled === true ? "pass" : rbacResult.enabled === false ? "fail" : "unknown";
          return {
            type: "automated_secfn",
            outcome,
            timestamp: Date.now(),
            payload: { rbac: rbacResult, method },
          };
        }
        return {
          type: "automated_secfn",
          outcome: "unknown",
          timestamp: Date.now(),
          payload: { reason: "requested client method unavailable or unsupported", method },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          type: "automated_secfn",
          outcome: "fail",
          timestamp: Date.now(),
          payload: { error: message, method },
        };
      }
    },
  };
}
