/**
 * Transaction execution logic
 */

import type { DatafnSchema } from "@datafn/core";
import type { Adapter } from "@superfunctions/db";
import type { IdempotencyStore, MutationResult } from "./idempotency.js";
import type { DFQLMutation } from "./mutation/dfql.js";
import type { SequenceStore } from "./sync/sequence-store.js";
import { executeMutation } from "./mutation/execute.js";
import { executeQuery } from "./query/execute.js";
import { DbDataStore } from "./db-store.js";
import { ChangeTrackingService } from "./sync/change-tracking.js";

export interface TransactStep {
  query?: any;
  mutation?: DFQLMutation;
}

export interface TransactResult {
  ok: boolean;
  result?: {
    ok: boolean;
    results: Array<any>;
  };
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

/**
 * Execute a transaction (sequence of mutations/queries) as an atomic unit
 */
export async function executeTransaction(
  request: { atomic?: boolean; steps: TransactStep[] },
  schema: DatafnSchema,
  db: Adapter,
  idempotencyStore: IdempotencyStore,
  limits?: { maxTransactSteps?: number },
  namespace: string,
  sequenceStore?: SequenceStore,
): Promise<TransactResult> {
  const steps = request.steps;
  const isAtomic = request.atomic !== false; // Default true

  // Enforce step limits
  const maxSteps = limits?.maxTransactSteps ?? 100;
  if (steps.length > maxSteps) {
    return {
      ok: false,
      error: {
        code: "LIMIT_EXCEEDED",
        message: "Transaction exceeds maximum steps",
        details: { path: "steps", max: maxSteps },
      },
    };
  }

  const results: Array<any> = [];
  const changeTracking = new ChangeTrackingService(db, namespace, sequenceStore);

  // Helper to execute a single step
  const executeStep = async (step: TransactStep, stepDb: Adapter) => {
    if (step.query) {
      // Create store for query
      const store = await DbDataStore.forQuery(stepDb, step.query, schema);
      // Execute query
      const queryResult = executeQuery(step.query, schema, store);
      return queryResult;
    } else if (step.mutation) {
      // Execute mutation
      const mutationResult = await executeMutation(
        step.mutation,
        schema,
        stepDb,
        idempotencyStore,
        changeTracking,
      );
      // Expose the first error as a top-level `.error` property so that
      // transact callers can access result.results[i].error.code directly
      // (in addition to the standard errors[] array).
      if (!mutationResult.ok && mutationResult.errors?.length > 0) {
        const e = mutationResult.errors[0];
        return {
          ...mutationResult,
          error: { code: e.code, message: e.message, path: e.path },
        };
      }
      return mutationResult;
    }
    return null; // Should not happen due to validation
  };

  if (isAtomic && typeof (db as any).transaction === "function") {
    // Atomic execution with DB transaction support
    try {
      await (db as any).transaction(async (tx: Adapter) => {
        for (const step of steps) {
          const result = await executeStep(step, tx);
          results.push(result);

          if (step.mutation) {
            const mutRes = result as MutationResult;
            if (!mutRes.ok) {
              // Rollback by throwing
              throw new Error("TRANSACTION_FAILED");
            }
          }
        }
      });
      // If we got here, commit happened
      return { ok: true, result: { ok: true, results } };
    } catch (error: any) {
      if (error.message === "TRANSACTION_FAILED") {
        // Return 200 OK but with transaction failure
        // We need to return results including the failed one
        return {
          ok: true,
          result: {
            ok: false,
            results: results,
          },
        };
      }
      // Adapter doesn't support transactions (e.g. memory adapter) — fall through
      // to sequential execution below. Clear any partial results first.
      results.length = 0;
    }
  }

  // Sequential execution (non-atomic, or atomic fallback when transaction not supported)
  for (const step of steps) {
    try {
      const result = await executeStep(step, db);
      results.push(result);

      if (isAtomic && step.mutation) {
        const mutRes = result as any;
        if (mutRes?.ok === false) {
          // Stop on first failure if atomic (even without rollback support we stop)
          return { ok: true, result: { ok: false, results } };
        }
      }
    } catch (e: any) {
      // Unexpected error during step execution
      console.log("Transact Step Error:", e);
      // Map to an error result
      results.push({
        ok: false,
        error: { code: e.code || "INTERNAL", message: e.message }
      });
      if (isAtomic) return { ok: true, result: { ok: false, results } };
    }
  }

  // Check for any failures in results
  const anyFailed = results.some(r => {
    if (r == null) return false;
    if (typeof r === 'object' && 'ok' in r) return !r.ok;
    return false;
  });

  return { ok: true, result: { ok: !anyFailed, results } };
}
