/**
 * Frameworks CRUD service with requirement/controlId validation (FW-001, FW-002, LIMIT-001).
 * All methods return CompfnEnvelope; FRAMEWORK_NOT_FOUND when id does not exist;
 * VALIDATION_FAILED when requirement controlIds reference nonexistent control or limits exceeded.
 */

import type { Adapter } from "@superfunctions/db";
import type {
  Framework,
  CreateFrameworkInput,
  FrameworkRequirement,
} from "../framework.js";
import type { CompfnEnvelope, CompfnError } from "../errors.js";
import {
  validateCreateFrameworkInput,
  validateUpdateFrameworkInput,
} from "../validation.js";

const MODEL = "frameworks";

export interface FrameworksServiceConfig {
  database: Adapter;
  namespace?: string;
  /** Check that a control exists by id (e.g. from controls.get(id).then(r => r.ok)) */
  existsControl: (controlId: string) => Promise<boolean>;
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

function rowToFramework(row: Record<string, unknown>): Framework {
  const requirements = row.requirements;
  return {
    id: String(row.id),
    name: String(row.name),
    version: row.version != null ? String(row.version) : undefined,
    description: row.description != null ? String(row.description) : undefined,
    requirements: Array.isArray(requirements)
      ? (requirements as FrameworkRequirement[]).map((r) => ({
          requirementId: String(r.requirementId),
          controlIds: Array.isArray(r.controlIds) ? (r.controlIds as string[]).slice() : [],
          name: r.name != null ? String(r.name) : undefined,
        }))
      : [],
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

async function validateControlIdsExist(
  requirements: FrameworkRequirement[],
  existsControl: (id: string) => Promise<boolean>
): Promise<{ ok: true } | { ok: false; error: CompfnError }> {
  const missing: { requirementId?: string; controlId?: string }[] = [];
  for (const req of requirements) {
    for (const controlId of req.controlIds) {
      const exists = await existsControl(controlId);
      if (!exists) {
        missing.push({ requirementId: req.requirementId, controlId });
      }
    }
  }
  if (missing.length > 0) {
    const first = missing[0];
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "One or more controlIds do not exist",
        details: {
          path: "requirements",
          requirementId: first.requirementId,
          controlId: first.controlId,
          missingCount: missing.length,
        },
      },
    };
  }
  return { ok: true };
}

export function createFrameworksService(config: FrameworksServiceConfig) {
  const namespace = config.namespace ?? defaultNamespace();

  function withNamespace<P extends object>(params: P): P & { namespace: string } {
    return { ...params, namespace } as P & { namespace: string };
  }

  return {
    async create(input: CreateFrameworkInput): Promise<CompfnEnvelope<Framework>> {
      const validation = validateCreateFrameworkInput(input);
      if (!validation.ok) {
        return { ok: false, error: validation.error };
      }
      const { value } = validation;
      const controlCheck = await validateControlIdsExist(
        value.requirements,
        config.existsControl
      );
      if (!controlCheck.ok) {
        return { ok: false, error: controlCheck.error };
      }
      const id = generateId();
      const ts = now();
      const data = {
        id,
        name: value.name,
        version: value.version ?? null,
        description: value.description ?? null,
        requirements: value.requirements,
        createdAt: ts,
        updatedAt: ts,
      };
      try {
        const created = await config.database.create(
          withNamespace({ model: MODEL, data })
        );
        return { ok: true, result: rowToFramework(created as Record<string, unknown>) };
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

    async get(id: string): Promise<CompfnEnvelope<Framework>> {
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
              code: "FRAMEWORK_NOT_FOUND",
              message: "Framework not found",
              details: { id },
            },
          };
        }
        return { ok: true, result: rowToFramework(row as Record<string, unknown>) };
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

    async list(): Promise<CompfnEnvelope<Framework[]>> {
      try {
        const params = withNamespace({
          model: MODEL,
          where: [],
          orderBy: [{ field: "updatedAt", direction: "desc" as const }],
        });
        const rows = await config.database.findMany(params);
        const frameworks = rows.map((r: Record<string, unknown>) => rowToFramework(r));
        return { ok: true, result: frameworks };
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

    async update(
      id: string,
      input: Partial<CreateFrameworkInput>
    ): Promise<CompfnEnvelope<Framework>> {
      const validation = validateUpdateFrameworkInput(input);
      if (!validation.ok) {
        return { ok: false, error: validation.error };
      }
      const { value } = validation;
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
              code: "FRAMEWORK_NOT_FOUND",
              message: "Framework not found",
              details: { id },
            },
          };
        }
        const existingRow = existing as Record<string, unknown>;
        const requirements = value.requirements ?? rowToFramework(existingRow).requirements;
        const controlCheck = await validateControlIdsExist(
          requirements,
          config.existsControl
        );
        if (!controlCheck.ok) {
          return { ok: false, error: controlCheck.error };
        }
        const data: Record<string, unknown> = {
          ...existingRow,
          updatedAt: now(),
        };
        if (value.name !== undefined) data.name = value.name;
        if (value.version !== undefined) data.version = value.version ?? null;
        if (value.description !== undefined) data.description = value.description ?? null;
        if (value.requirements !== undefined) data.requirements = value.requirements;
        await config.database.update(
          withNamespace({
            model: MODEL,
            where: [{ field: "id", operator: "eq", value: id }],
            data,
          })
        );
        const updated = await config.database.findOne(
          withNamespace({
            model: MODEL,
            where: [{ field: "id", operator: "eq", value: id }],
          })
        );
        return {
          ok: true,
          result: rowToFramework(updated as Record<string, unknown>),
        };
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
              code: "FRAMEWORK_NOT_FOUND",
              message: "Framework not found",
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
  };
}
