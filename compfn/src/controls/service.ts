/**
 * Controls CRUD service using storage adapter.
 * All methods return CompfnEnvelope; CONTROL_NOT_FOUND when id does not exist.
 */

import type { Adapter } from "@superfunctions/db";
import type { Control, CreateControlInput, UpdateControlInput } from "../control.js";
import type { CompfnEnvelope, CompfnError } from "../errors.js";
import { validateCreateControlInput, validateUpdateControlInput } from "../validation.js";

const MODEL = "controls";

export interface ControlsServiceConfig {
  database: Adapter;
  namespace?: string;
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

function rowToControl(row: Record<string, unknown>): Control {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    category: String(row.category),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function ensureTags(control: Control, row: Record<string, unknown>): Control {
  if (Array.isArray(row.tags)) {
    control.tags = (row.tags as string[]).slice();
  }
  return control;
}

export function createControlsService(config: ControlsServiceConfig) {
  const namespace = config.namespace ?? defaultNamespace();

  function withNamespace<P extends object>(params: P): P & { namespace: string } {
    return { ...params, namespace } as P & { namespace: string };
  }

  return {
    async create(input: CreateControlInput): Promise<CompfnEnvelope<Control>> {
      const validation = validateCreateControlInput(input);
      if (!validation.ok) {
        return { ok: false, error: validation.error };
      }
      const { value } = validation;
      const id = generateId();
      const ts = now();
      const data = {
        id,
        name: value.name,
        description: value.description,
        category: value.category,
        tags: value.tags ?? null,
        createdAt: ts,
        updatedAt: ts,
      };
      try {
        const created = await config.database.create(
          withNamespace({ model: MODEL, data })
        );
        const control = ensureTags(rowToControl(created as Record<string, unknown>), created as Record<string, unknown>);
        return { ok: true, result: control };
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

    async get(id: string): Promise<CompfnEnvelope<Control>> {
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
              code: "CONTROL_NOT_FOUND",
              message: "Control not found",
              details: { id },
            },
          };
        }
        const r = row as Record<string, unknown>;
        const control = ensureTags(rowToControl(r), r);
        return { ok: true, result: control };
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

    async list(filters?: {
      category?: string;
      tags?: string[];
    }): Promise<CompfnEnvelope<Control[]>> {
      try {
        const where: { field: string; operator: "eq" | "in"; value: string | string[] }[] = [];
        if (filters?.category != null && filters.category !== "") {
          where.push({ field: "category", operator: "eq", value: filters.category });
        }
        const params = withNamespace({
          model: MODEL,
          where: where.map((w) => ({ ...w, connector: "AND" as const })),
          orderBy: [{ field: "updatedAt", direction: "desc" as const }],
        });
        let rows = await config.database.findMany(params);
        if (filters?.tags != null && filters.tags.length > 0) {
          const tagSet = new Set(filters.tags);
          rows = rows.filter((row: Record<string, unknown>) => {
            const tags = row.tags;
            if (!Array.isArray(tags)) return false;
            return (tags as string[]).some((t: string) => tagSet.has(t));
          });
        }
        const controls = rows.map((r: Record<string, unknown>) =>
          ensureTags(rowToControl(r), r)
        );
        return { ok: true, result: controls };
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

    async update(id: string, input: UpdateControlInput): Promise<CompfnEnvelope<Control>> {
      const validation = validateUpdateControlInput(input);
      if (!validation.ok) {
        return { ok: false, error: validation.error };
      }
      const { value } = validation;
      if (Object.keys(value).length === 0) {
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
              code: "CONTROL_NOT_FOUND",
              message: "Control not found",
              details: { id },
            },
          };
        }
        const r = row as Record<string, unknown>;
        return { ok: true, result: ensureTags(rowToControl(r), r) };
      }
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
              code: "CONTROL_NOT_FOUND",
              message: "Control not found",
              details: { id },
            },
          };
        }
        const existingRow = existing as Record<string, unknown>;
        const data: Record<string, unknown> = {
          ...existingRow,
          updatedAt: now(),
        };
        if (value.name !== undefined) data.name = value.name;
        if (value.description !== undefined) data.description = value.description;
        if (value.category !== undefined) data.category = value.category;
        if (value.tags !== undefined) data.tags = value.tags;
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
        const r = updated as Record<string, unknown>;
        const control = ensureTags(rowToControl(r), r);
        return { ok: true, result: control };
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
              code: "CONTROL_NOT_FOUND",
              message: "Control not found",
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
