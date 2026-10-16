import type { CompFnAPI, CompfnEnvelope } from "compfn";
import { AdminError, type AdminOperationContext, type AdminOperationResult, type AdminScope } from "@superfunctions/admin";
import { createCompFnPaginator } from "./pagination.js";
import type { CompFnAdminService } from "./index.js";

type JsonRecord = Record<string, unknown>;

export type CompFnDomainAdminServiceOptions = {
  /** Share a random secret of at least 32 bytes across replicas; omit for instance-local cursors. */
  cursorSecret?: Uint8Array;
} & (
  | {
      /** A single CompFn instance may only be exposed with its exact workspace binding. */
      compfn: CompFnAPI;
      scope: Pick<AdminScope, "workspaceId"> & Partial<Omit<AdminScope, "workspaceId">>;
      resolveCompfn?: never;
    }
  | {
      /** Resolves the authorized administration scope to its isolated CompFn instance. */
      resolveCompfn: (context: AdminOperationContext) => CompFnAPI | Promise<CompFnAPI>;
      compfn?: never;
      scope?: never;
    });

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AdminError("invalid_argument", `${name} must be a non-empty string.`);
  }
  return value;
}

function unwrap<T>(value: CompfnEnvelope<T>): T {
  if (value.ok) return value.result;
  const code = value.error.code.endsWith("_NOT_FOUND")
    ? "not_found"
    : value.error.code === "RATE_LIMITED"
      ? "rate_limited"
      : value.error.code === "STORAGE_ERROR" || value.error.code === "ADAPTER_ERROR"
        ? "dependency_unavailable"
        : "invalid_argument";
  throw new AdminError(code, value.error.message, { details: value.error.details });
}

function item(value: object): AdminOperationResult<JsonRecord> {
  return { ok: true, data: { item: JSON.parse(JSON.stringify(value)) } };
}

function accepted(value: object): AdminOperationResult<JsonRecord> {
  return { ok: true, data: { accepted: true, item: JSON.parse(JSON.stringify(value)) } };
}

/** Delegates every operation to the configured CompFn API and its namespaced database services. */
export function createCompFnDomainAdminService(
  options: CompFnDomainAdminServiceOptions,
): CompFnAdminService {
  if (options.compfn && !options.scope?.workspaceId) {
    throw new AdminError("invalid_argument", "A static CompFn admin binding requires workspaceId.");
  }
  const compfnFor = async (context: AdminOperationContext): Promise<CompFnAPI> => {
    if (options.resolveCompfn) return options.resolveCompfn(context);
    if (!options.compfn || !options.scope) {
      throw new AdminError("dependency_unavailable", "CompFn administration has no scoped service binding.");
    }
    for (const key of ["installationId", "organizationId", "workspaceId", "projectId", "environmentId", "namespace", "region"] as const) {
      const expected = options.scope[key];
      if (expected !== undefined && context.scope[key] !== expected) {
        throw new AdminError("forbidden", `CompFn is not bound to the active ${key}.`);
      }
    }
    return options.compfn;
  };
  const paginate = createCompFnPaginator(options.cursorSecret);
  return {
    async listFrameworks(input, context) {
      return paginate("frameworks", input, context, async () => unwrap(await (await compfnFor(context)).frameworks.list()));
    },
    async getFramework(input, context) {
      return item(unwrap(await (await compfnFor(context)).frameworks.get(string(input.id, "id"))));
    },
    async listControls(input, context) {
      return paginate("controls", input, context, async (filter) => unwrap(await (await compfnFor(context)).controls.list({ category: filter.category as string | undefined, tags: filter.tags as string[] | undefined })));
    },
    async getControl(input, context) {
      return item(unwrap(await (await compfnFor(context)).controls.get(string(input.id, "id"))));
    },
    async listChecks(input, context) {
      return paginate("checks", input, context, async () => unwrap(await (await compfnFor(context)).checks.list()));
    },
    async getCheck(input, context) {
      return item(unwrap(await (await compfnFor(context)).checks.get(string(input.id, "id"))));
    },
    async listEvidence(input, context) {
      return paginate("evidence", input, context, async (filter) => unwrap(await (await compfnFor(context)).evidence.list({ frameworkId: filter.frameworkId as string | undefined, controlId: filter.controlId as string | undefined, type: filter.type as NonNullable<Parameters<CompFnAPI["evidence"]["list"]>[0]>["type"], since: filter.since as number | undefined })));
    },
    async getEvidence(input, context) {
      return item(unwrap(await (await compfnFor(context)).evidence.get(string(input.id, "id"))));
    },
    async collectEvidence(input, context) {
      const compfn = await compfnFor(context);
      return accepted(unwrap(await compfn.evidence.create(input.payload as unknown as Parameters<CompFnAPI["evidence"]["create"]>[0])));
    },
    async generateReport(input, context) {
      const compfn = await compfnFor(context);
      return accepted(unwrap(await compfn.export.auditorPack({
        frameworkId: input.payload?.frameworkId,
        since: input.payload?.since,
      })));
    },
  };
}
