/**
 * Authfn evidence adapter: calls authfn (or mock client) for MFA/session/user info;
 * returns AdapterEvidence with type "automated_authfn".
 */

import type { EvidenceAdapter, AdapterCheckInput, AdapterEvidence } from "./types.js";

/**
 * Minimal authfn client interface for the adapter. Implementations may call real authfn
 * APIs; tests can pass a mock that returns fixed data.
 */
export interface AuthfnClient {
  getMfaStatus?(options?: { method?: string; customConfig?: Record<string, unknown> }): Promise<{ enforced: boolean; summary?: string }>;
  getSessionPolicy?(options?: { method?: string; customConfig?: Record<string, unknown> }): Promise<{ maxSessionAge?: number; policy?: string }>;
  getUserInfo?(options?: { method?: string; customConfig?: Record<string, unknown> }): Promise<{ count?: number; mfaCoverage?: number }>;
}

export interface AuthfnAdapterConfig {
  /** Authfn client (real or mock). Required for runCheck to produce evidence. */
  client: AuthfnClient;
}

const ADAPTER_NAME = "authfn";

/**
 * Authfn evidence adapter. runCheck() calls the configured client (e.g. getMfaStatus,
 * getSessionPolicy based on input.method) and maps the result to AdapterEvidence
 * with type "automated_authfn".
 */
export function createAuthfnAdapter(config: AuthfnAdapterConfig): EvidenceAdapter {
  const { client } = config;

  return {
    name: ADAPTER_NAME,
    async runCheck(input: AdapterCheckInput): Promise<AdapterEvidence> {
      const method = input.method ?? "getMfaStatus";
      const opts = { method: input.method, customConfig: input.customConfig };

      try {
        if (method === "getSessionPolicy" && client.getSessionPolicy) {
          const policy = await client.getSessionPolicy(opts);
          return {
            type: "automated_authfn",
            outcome: "unknown",
            timestamp: Date.now(),
            payload: { sessionPolicy: policy, method },
          };
        }
        if (method === "getUserInfo" && client.getUserInfo) {
          const info = await client.getUserInfo(opts);
          return {
            type: "automated_authfn",
            outcome: "unknown",
            timestamp: Date.now(),
            payload: { userInfo: info, method },
          };
        }
        // Default: getMfaStatus
        if (method === "getMfaStatus" && client.getMfaStatus) {
          const mfaResult = await client.getMfaStatus(opts);
          const outcome = mfaResult.enforced === true ? "pass" : mfaResult.enforced === false ? "fail" : "unknown";
          return {
            type: "automated_authfn",
            outcome,
            timestamp: Date.now(),
            payload: { mfa: mfaResult, method },
          };
        }
        return {
          type: "automated_authfn",
          outcome: "unknown",
          timestamp: Date.now(),
          payload: { reason: "requested client method unavailable or unsupported", method },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          type: "automated_authfn",
          outcome: "fail",
          timestamp: Date.now(),
          payload: { error: message, method },
        };
      }
    },
  };
}
