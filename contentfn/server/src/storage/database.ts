import type { Adapter, TransactionAdapter } from "@superfunctions/db";
import type { ContentfnEnvelope } from "@contentfn/core";
import { err } from "@contentfn/core";

export type ContentfnDatabase = Adapter | TransactionAdapter;
class AbortedMutation<T> extends Error {
  constructor(readonly result: ContentfnEnvelope<T>) { super("Content mutation aborted"); }
}

/** All related writes commit together, including revision and durable event records. */
export async function atomicMutation<T>(
  db: Adapter,
  operation: (transaction: TransactionAdapter) => Promise<ContentfnEnvelope<T>>,
): Promise<ContentfnEnvelope<T>> {
  try {
    return await db.transaction(async transaction => {
      // Some adapters retain root-only methods on their runtime transaction object.
      // Hide these at the function boundary so nested storage calls reuse this transaction.
      const scoped = new Proxy(transaction, {
        has: (target, key) => key !== "transaction" && key !== "close" && Reflect.has(target, key),
        get: (target, key) => key === "transaction" || key === "close" ? undefined : Reflect.get(target, key),
      });
      const result = await operation(scoped);
      if (!result.ok) throw new AbortedMutation(result);
      return result;
    });
  } catch (error) {
    if (error instanceof AbortedMutation) return error.result as ContentfnEnvelope<T>;
    return err("STORAGE_ERROR", "The content transaction could not be completed", {});
  }
}
