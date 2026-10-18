import { randomUUID } from "node:crypto";
/**
 * Evidence service: create, get, list (immutable; no update/delete).
 * Validates controlId exists, type in EvidenceType, payload size ≤ evidencePayloadMaxBytes.
 * Returns VALIDATION_FAILED for invalid controlId or type; PAYLOAD_TOO_LARGE when payload exceeds limit.
 */

import type { Adapter } from "@superfunctions/db";
import type { Evidence, CreateEvidenceInput } from "../evidence.js";
import type { CompfnEnvelope } from "../errors.js";
import type { Logger } from "../logger.js";
import { validateCreateEvidenceInput } from "../validation.js";
import { EVIDENCE_PAYLOAD_MAX_BYTES_DEFAULT } from "../constants.js";
import { defaultLogger } from "../logger.js";

const MODEL = "evidence";

export interface EvidenceServiceConfig {
  database: Adapter;
  namespace?: string;
  evidencePayloadMaxBytes?: number;
  /** Check that a control exists (e.g. controls.get(id).then(r => r.ok)) */
  existsControl: (controlId: string) => Promise<CompfnEnvelope<boolean>>;
  /** Get framework by id to resolve requirement controlIds (for list by frameworkId) */
  getFramework: (frameworkId: string) => Promise<{ requirements: { controlIds: string[] }[] } | null>;
  logger?: Logger;
}

function defaultNamespace(): string {
  return "compfn";
}

function generateId(): string {
  return randomUUID();
}

function now(): number {
  return Date.now();
}

function rowToEvidence(row: Record<string, unknown>): Evidence {
  const evidence: Evidence = {
    id: String(row.id),
    controlId: String(row.controlId),
    type: String(row.type) as Evidence["type"],
    timestamp: Number(row.timestamp),
    actorId: String(row.actorId),
    outcome: String(row.outcome) as "pass" | "fail" | "unknown",
    createdAt: Number(row.createdAt),
  };
  if (row.sourceId != null && row.sourceId !== "") {
    evidence.sourceId = String(row.sourceId);
  }
  if (row.frameworkRequirementId != null && row.frameworkRequirementId !== "") {
    evidence.frameworkRequirementId = String(row.frameworkRequirementId);
  }
  if (row.payload != null && typeof row.payload === "object") {
    evidence.payload = row.payload as Record<string, unknown>;
  }
  if (row.artifactRef != null && row.artifactRef !== "") {
    evidence.artifactRef = String(row.artifactRef);
  }
  return evidence;
}

export function createEvidenceService(config: EvidenceServiceConfig) {
  const namespace = config.namespace ?? defaultNamespace();
  const maxPayloadBytes = config.evidencePayloadMaxBytes ?? EVIDENCE_PAYLOAD_MAX_BYTES_DEFAULT;
  const logger = config.logger ?? defaultLogger;

  function withNamespace<P extends object>(params: P): P & { namespace: string } {
    return { ...params, namespace } as P & { namespace: string };
  }

  return {
    async create(input: CreateEvidenceInput): Promise<CompfnEnvelope<Evidence>> {
      const validation = validateCreateEvidenceInput(input);
      if (!validation.ok) {
        return { ok: false, error: validation.error };
      }
      const value = validation.value;

      const controlExists = await config.existsControl(value.controlId);
      if (!controlExists.ok) return controlExists;
      if (!controlExists.result) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_FAILED",
            message: "Control not found",
            details: { controlId: value.controlId },
          },
        };
      }

      if (value.payload != null) {
        let payloadJson: string;
        try {
          payloadJson = JSON.stringify(value.payload);
          if (payloadJson === undefined) throw new Error("Payload must be JSON serializable");
        } catch {
          return { ok: false, error: { code: "VALIDATION_FAILED", message: "Payload must be JSON serializable", details: { path: "payload" } } };
        }
        const payloadBytes = new TextEncoder().encode(payloadJson).length;
        if (payloadBytes > maxPayloadBytes) {
          return {
            ok: false,
            error: {
              code: "PAYLOAD_TOO_LARGE",
              message: `Payload size ${payloadBytes} exceeds limit ${maxPayloadBytes}`,
              details: { limit: maxPayloadBytes, size: payloadBytes },
            },
          };
        }
      }

      const id = generateId();
      const timestamp = value.timestamp ?? now();
      const createdAt = now();
      const data: Record<string, unknown> = {
        id,
        controlId: value.controlId,
        type: value.type,
        timestamp,
        actorId: value.actorId,
        outcome: value.outcome,
        createdAt,
      };
      if (value.sourceId != null) data.sourceId = value.sourceId;
      if (value.frameworkRequirementId != null) data.frameworkRequirementId = value.frameworkRequirementId;
      if (value.payload != null) data.payload = value.payload;
      if (value.artifactRef != null) data.artifactRef = value.artifactRef;

      try {
        const created = await config.database.create(
          withNamespace({ model: MODEL, data })
        );
        const result = rowToEvidence(created as Record<string, unknown>);
        logger.info("evidence.created", {
          event: "evidence.created",
          evidenceId: result.id,
          controlId: result.controlId,
          type: result.type,
          outcome: result.outcome,
        });
        return { ok: true, result };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "STORAGE_ERROR",
            message: err instanceof Error ? err.message : "Storage error",
            details: {},
          },
        };
      }
    },

    async get(id: string): Promise<CompfnEnvelope<Evidence>> {
      try {
        const row = await config.database.findOne(
          withNamespace({
            model: MODEL,
            where: [{ field: "id", operator: "eq", value: id }],
          })
        );
        if (row == null) {
          return {
            ok: false,
            error: {
              code: "EVIDENCE_NOT_FOUND",
              message: "Evidence not found",
              details: { id },
            },
          };
        }
        return { ok: true, result: rowToEvidence(row as Record<string, unknown>) };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "STORAGE_ERROR",
            message: err instanceof Error ? err.message : "Storage error",
            details: { id },
          },
        };
      }
    },

    async list(filters: {
      controlId?: string;
      frameworkId?: string;
      type?: string;
      since?: number;
    }): Promise<CompfnEnvelope<Evidence[]>> {
      try {
        let controlIds: string[] | undefined;
        if (filters.frameworkId != null && filters.frameworkId !== "") {
          const fw = await config.getFramework(filters.frameworkId);
          if (fw == null) {
            return {
              ok: false,
              error: {
                code: "FRAMEWORK_NOT_FOUND",
                message: "Framework not found",
                details: { frameworkId: filters.frameworkId },
              },
            };
          }
          const set = new Set<string>();
          for (const req of fw.requirements) {
            for (const cid of req.controlIds) {
              set.add(cid);
            }
          }
          controlIds = Array.from(set);
          if (filters.controlId != null && filters.controlId !== "") {
            controlIds = set.has(filters.controlId) ? [filters.controlId] : [];
          }
          if (controlIds.length === 0) {
            return { ok: true, result: [] };
          }
        }

        const where: { field: string; operator: "eq" | "in" | "gte"; value: string | string[] | number; connector?: "AND" }[] = [];
        if (controlIds != null && controlIds.length > 0) {
          where.push({ field: "controlId", operator: "in", value: controlIds });
        } else if (filters.controlId != null && filters.controlId !== "") {
          where.push({ field: "controlId", operator: "eq", value: filters.controlId });
        }
        if (filters.type != null && filters.type !== "") {
          where.push({ field: "type", operator: "eq", value: filters.type });
        }
        if (filters.since != null && Number.isFinite(filters.since)) {
          where.push({ field: "timestamp", operator: "gte", value: filters.since });
        }

        const withConnector = where.map((w, i) => ({ ...w, connector: i === 0 ? undefined : ("AND" as const) }));
        const params = withNamespace({
          model: MODEL,
          where: withConnector,
          orderBy: [{ field: "createdAt", direction: "desc" as const }],
        });
        const rows = await config.database.findMany({ ...params, limit: 1001 });
        if (rows.length > 1000) return { ok: false, error: { code: "VALIDATION_FAILED", message: "List exceeds 1000 records; narrow the query", details: { limit: 1000 } } };
        const evidence = rows.map((r: Record<string, unknown>) => rowToEvidence(r));
        return { ok: true, result: evidence };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "STORAGE_ERROR",
            message: err instanceof Error ? err.message : "Storage error",
            details: {},
          },
        };
      }
    },
  };
}
