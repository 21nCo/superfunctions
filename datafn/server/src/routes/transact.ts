import type { DatafnSchema, DatafnPlugin } from "../core-types.js";
import type { Adapter } from "@superfunctions/db";
import type { IdempotencyStore } from "../execution/idempotency.js";
import type { SequenceStore } from "../execution/sync/sequence-store.js";
import { getBodyFromContext } from "../http/json.js";
import { okResponse, errorResponse } from "../http/errors.js";
import { executeTransaction } from "../execution/transact.js";
import { buildSchemaIndex, validateMutation, validateQuery } from "../validation/index.js";
import { validateQueryAuthz, validateMutationAuthz, type AuthzOptions } from "../validation/authz.js";
import { parseDatafnRequest } from "@datafn/core";
import { logRequest } from "../logging.js";
import type { DatafnLogger } from "../logger.js";

/**
 * Options for transact handler
 */
export interface TransactHandlerOpts {
  allowUnknownResources?: boolean;
  debug?: boolean;
}

/**
 * Create transaction route handler
 */
export function createTransactHandler(
  validatedSchema: DatafnSchema,
  db: Adapter | undefined,
  idempotencyStore: IdempotencyStore | undefined,
  limits: { maxTransactSteps?: number } | undefined,
  extractNamespace: (ctx: any) => Promise<string>,
  extractActorId: ((ctx: any) => Promise<string | undefined>) | undefined,
  sequenceStore: SequenceStore | undefined,
  plugins: DatafnPlugin[] = [],
  handlerOpts?: TransactHandlerOpts,
  logger?: DatafnLogger,
) {
  // Build schema index once for efficient validation
  const schemaIndex = buildSchemaIndex(validatedSchema);

  return async (req: Request, ctx?: { parsedBody?: unknown }): Promise<Response> => {
    const startTime = Date.now();
    let body: any;

    try {
        // Get body from context (pre-parsed by withAuth) or parse from request
        const parseResult = await getBodyFromContext(req, ctx);
        if (!parseResult.ok) {
        return errorResponse(parseResult.error);
        }
        body = parseResult.data as any;

        // PHASE_01: Validate body structure and schema compliance BEFORE checking execution requirements
        if (!body || !Array.isArray(body.steps)) {
        return errorResponse({
            code: "DFQL_INVALID",
            message: "Invalid DFQL: expected 'steps' array",
            details: { path: "steps" },
        });
        }

        // Validate step limits
        const maxSteps = limits?.maxTransactSteps ?? 100;
        if (body.steps.length > maxSteps) {
        return errorResponse({
            code: "LIMIT_EXCEEDED",
            message: "Transaction exceeds maximum steps",
            details: { path: "steps", max: maxSteps },
        });
        }

        // Reuse the protocol's classification for schema validation, authorization, and execution.
        const parsed = parseDatafnRequest("transact", body);
        if (!parsed.ok) return errorResponse(parsed.error);
        if (parsed.result.kind !== "transact") throw new Error("Expected transact protocol");
        const prepared = parsed.result.steps.map(({ type: kind }, index) => {
          const raw = body.steps[index];
          const wrapped = raw[kind] !== undefined;
          return {
            kind,
            body: (wrapped ? raw[kind] : raw) as Record<string, unknown>,
            pathSuffix: wrapped ? `.${kind}` : "",
          };
        });

        for (let i = 0; i < prepared.length; i++) {
          const step = prepared[i]!;
          const path = `steps[${i}]${step.pathSuffix}`;
          // Bare unsupported operation names stay per-step errors (TV-TRX-002).
          // Wrapped steps do not get that pass.
          let validationResult = step.kind === "mutation"
            ? validateMutation(step.body, schemaIndex, path)
            : validateQuery(step.body, schemaIndex, path);
          if (
            step.kind === "mutation" &&
            step.pathSuffix === "" &&
            !validationResult.ok &&
            validationResult.error.code === "DFQL_UNSUPPORTED" &&
            validationResult.error.path.endsWith(".operation")
          ) {
            validationResult = { ok: true, result: undefined as any };
          }

          if (!validationResult.ok) {
            const { code, message, path: errorPath } = validationResult.error as { code: string; message: string; path: string };
            return errorResponse({
              code: code as any,
              message: handlerOpts?.debug ? message : "Validation error",
              details: { path: errorPath },
            });
          }
        }

        // SEC-004: Per-step authz validation (VAL-001: deny-by-default)
        const authzOpts: AuthzOptions = {
          allowUnknownResources: handlerOpts?.allowUnknownResources,
          debug: handlerOpts?.debug,
        };
        for (let i = 0; i < prepared.length; i++) {
          const step = prepared[i]!;
          const authzResult = step.kind === "mutation"
            ? validateMutationAuthz(step.body, validatedSchema, authzOpts)
            : validateQueryAuthz(step.body, validatedSchema, authzOpts);

          if (!authzResult.ok) {
            return errorResponse({
              code: authzResult.code,
              message: authzResult.message,
              details: { path: `steps[${i}].${authzResult.path}` },
            }, 403);
          }
        }

        // After validation, check execution requirements
        if (!db || !idempotencyStore) {
        return errorResponse({
            code: "INTERNAL",
            message: "Internal error",
            details: { path: "$" },
        });
        }

        // Extract namespace from context
        const namespace = await extractNamespace(ctx);
        const actorId = extractActorId ? await extractActorId(ctx) : undefined;

        const normalizedSteps = prepared.map((step) =>
          step.kind === "mutation" ? { mutation: step.body } : { query: step.body },
        );

        const result = await executeTransaction(
        { ...body, steps: normalizedSteps },
        validatedSchema,
        db,
        idempotencyStore,
        limits,
        namespace,
        actorId,
        sequenceStore,
        plugins,
        logger,
        handlerOpts?.allowUnknownResources === true,
        );

        if (!result.ok && result.error) {
            // Top-level error (e.g. limit exceeded if checked inside executor too)
            return errorResponse({
                code: result.error.code,
                message: result.error.message,
                details: result.error.details,
            });
        }

        // Success (200 OK), result contains { ok: true/false, results: [...] }
        return okResponse(result.result);
    } catch (error) {
        logger?.error("Transaction execution failed", { error: String(error), operation: "transact" });
        return errorResponse({
            code: "INTERNAL",
            message: "Internal error",
            details: { path: "$" }
        });
    } finally {
        logRequest({
            timestamp: new Date().toISOString(),
            endpoint: "/datafn/transact",
            operation: "transact",
            steps: body?.steps?.length,
            duration_ms: Date.now() - startTime,
        }, logger);
    }
  };
}
