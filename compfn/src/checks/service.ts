/**
 * Checks service: CRUD and run. run(id) loads check, resolves adapter, executes runCheck,
 * persists one evidence record, returns RunCheckResult. CHECK_NOT_FOUND / ADAPTER_NOT_FOUND / ADAPTER_ERROR as specified.
 */

import type { Adapter } from "@superfunctions/db";
import type { CheckDefinition, RunCheckResult } from "../check.js";
import type { Evidence, CreateEvidenceInput } from "../evidence.js";
import type { CompfnEnvelope } from "../errors.js";
import type { EvidenceAdapter } from "../api.js";
import type { Logger } from "../logger.js";
import { validateCreateCheckInput, type CreateCheckInput } from "../validation.js";
import { defaultLogger } from "../logger.js";

const MODEL = "checks";

export interface ChecksServiceConfig {
  database: Adapter;
  namespace?: string;
  /** Check that a control exists */
  existsControl: (controlId: string) => Promise<boolean>;
  /** Resolve adapter by name (from config.adapters[adapterName]) */
  getAdapter: (adapterName: string) => EvidenceAdapter | undefined;
  /** Default actor for automated check runs */
  systemActorId?: string;
  /** Create evidence record (from evidence service) */
  evidenceCreate: (input: CreateEvidenceInput) => Promise<CompfnEnvelope<Evidence>>;
  logger?: Logger;
}

function defaultNamespace(): string {
  return "compfn";
}

function generateId(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Date.now();
}

function rowToCheck(row: Record<string, unknown>): CheckDefinition {
  const check: CheckDefinition = {
    id: String(row.id),
    name: String(row.name),
    controlId: String(row.controlId),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
  if (row.schedule != null && row.schedule !== "") check.schedule = String(row.schedule);
  if (row.trigger != null && row.trigger !== "") check.trigger = String(row.trigger);
  if (row.adapterName != null && row.adapterName !== "") check.adapterName = String(row.adapterName);
  if (row.adapterMethod != null && row.adapterMethod !== "")
    check.adapterMethod = String(row.adapterMethod);
  if (row.customConfig != null && typeof row.customConfig === "object")
    check.customConfig = row.customConfig as Record<string, unknown>;
  return check;
}

export function createChecksService(config: ChecksServiceConfig) {
  const namespace = config.namespace ?? defaultNamespace();
  const systemActorId = config.systemActorId ?? "system";
  const logger = config.logger ?? defaultLogger;

  function withNamespace<P extends object>(params: P): P & { namespace: string } {
    return { ...params, namespace } as P & { namespace: string };
  }

  return {
    async create(
      definition: Omit<CheckDefinition, "id" | "createdAt" | "updatedAt">
    ): Promise<CompfnEnvelope<CheckDefinition>> {
      const validation = validateCreateCheckInput(definition);
      if (!validation.ok) {
        return { ok: false, error: validation.error };
      }
      const value = validation.value;

      const controlExists = await config.existsControl(value.controlId);
      if (!controlExists) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_FAILED",
            message: "Control not found",
            details: { controlId: value.controlId },
          },
        };
      }

      const id = generateId();
      const ts = now();
      const data: Record<string, unknown> = {
        id,
        name: value.name,
        controlId: value.controlId,
        createdAt: ts,
        updatedAt: ts,
      };
      if (value.schedule != null) data.schedule = value.schedule;
      if (value.trigger != null) data.trigger = value.trigger;
      if (value.adapterName != null) data.adapterName = value.adapterName;
      if (value.adapterMethod != null) data.adapterMethod = value.adapterMethod;
      if (value.customConfig != null) data.customConfig = value.customConfig;

      try {
        const created = await config.database.create(
          withNamespace({ model: MODEL, data })
        );
        return { ok: true, result: rowToCheck(created as Record<string, unknown>) };
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

    async get(id: string): Promise<CompfnEnvelope<CheckDefinition>> {
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
              code: "CHECK_NOT_FOUND",
              message: "Check not found",
              details: { id },
            },
          };
        }
        return { ok: true, result: rowToCheck(row as Record<string, unknown>) };
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

    async list(): Promise<CompfnEnvelope<CheckDefinition[]>> {
      try {
        const params = withNamespace({
          model: MODEL,
          where: [],
          orderBy: [{ field: "updatedAt", direction: "desc" as const }],
        });
        const rows = await config.database.findMany(params);
        const checks = rows.map((r: Record<string, unknown>) => rowToCheck(r));
        return { ok: true, result: checks };
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

    async delete(id: string): Promise<CompfnEnvelope<void>> {
      try {
        const existing = await config.database.findOne(
          withNamespace({
            model: MODEL,
            where: [{ field: "id", operator: "eq", value: id }],
          })
        );
        if (existing == null) {
          return {
            ok: false,
            error: {
              code: "CHECK_NOT_FOUND",
              message: "Check not found",
              details: { id },
            },
          };
        }
        await config.database.delete(
          withNamespace({
            model: MODEL,
            where: [{ field: "id", operator: "eq", value: id }],
          })
        );
        return { ok: true, result: undefined };
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

    async run(id: string): Promise<CompfnEnvelope<RunCheckResult>> {
      const checkRes = await this.get(id);
      if (!checkRes.ok) return checkRes;
      const check = checkRes.result;

      logger.info("check.run.started", {
        event: "check.run.started",
        checkId: check.id,
        controlId: check.controlId,
      });

      if (check.adapterName == null || check.adapterName.trim() === "") {
        return {
          ok: false,
          error: {
            code: "ADAPTER_NOT_FOUND",
            message: "Check has no adapter configured",
            details: { adapterName: "" },
          },
        };
      }

      const adapter = config.getAdapter(check.adapterName);
      if (adapter == null) {
        return {
          ok: false,
          error: {
            code: "ADAPTER_NOT_FOUND",
            message: "Adapter not found",
            details: { adapterName: check.adapterName },
          },
        };
      }

      let adapterEvidence;
      try {
        adapterEvidence = await adapter.runCheck({
          checkId: check.id,
          controlId: check.controlId,
          method: check.adapterMethod,
          customConfig: check.customConfig,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("check.run.error", {
          event: "check.run.error",
          checkId: check.id,
          code: "ADAPTER_ERROR",
        });
        const failPayload = { error: message };
        const failEvidenceRes = await config.evidenceCreate({
          controlId: check.controlId,
          type: "custom_check",
          sourceId: check.id,
          actorId: systemActorId,
          outcome: "fail",
          payload: failPayload,
        });
        return {
          ok: false,
          error: {
            code: "ADAPTER_ERROR",
            message,
            details: { adapterName: check.adapterName },
          },
        };
      }

      const timestamp = adapterEvidence.timestamp ?? now();
      const evidenceRes = await config.evidenceCreate({
        controlId: check.controlId,
        type: adapterEvidence.type,
        sourceId: check.id,
        actorId: systemActorId,
        outcome: adapterEvidence.outcome,
        timestamp,
        payload: adapterEvidence.payload,
        artifactRef: adapterEvidence.artifactRef,
        frameworkRequirementId: adapterEvidence.frameworkRequirementId,
      });

      if (!evidenceRes.ok) {
        return {
          ok: false,
          error: {
            code: "STORAGE_ERROR",
            message: "Failed to persist evidence after check run",
            details: { ...evidenceRes.error.details },
          },
        };
      }

      const result = {
        checkId: check.id,
        controlId: check.controlId,
        evidenceId: evidenceRes.result.id,
        outcome: adapterEvidence.outcome,
        timestamp,
      };

      logger.info("check.run.completed", {
        event: "check.run.completed",
        checkId: result.checkId,
        outcome: result.outcome,
      });

      return {
        ok: true,
        result,
      };
    },
  };
}
