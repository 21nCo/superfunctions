import { NotFoundError, type WhereClause } from '@superfunctions/db';
import type { AuthFnRuntimeConfig } from '../types.js';

/**
 * Updates one row by id only while `guards` still match, and reports whether
 * this call wrote it.
 *
 * Adapters do not all report affected rows the same way: some return 0 for a
 * write that happened, others NaN. So, as for OTP challenges:
 *
 * - with RETURNING support, the write is a single `update` that selects the
 *   id, and only a returned row counts;
 * - otherwise `updateMany` is used and any finite count above 0 counts.
 */
export async function updateRowIfMatches(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  model: string,
  id: string,
  guards: WhereClause[],
  data: Record<string, unknown>
): Promise<boolean> {
  const where: WhereClause[] = [
    { field: 'id', operator: 'eq', value: id },
    ...guards.map((guard) => ({ ...guard, connector: 'AND' as const }))
  ];
  const namespace = config.namespace ?? 'authfn';
  if (config.database.capabilities?.operations?.returning === true) {
    try {
      const row = await config.database.update<{ id?: unknown }>({
        model,
        where,
        data,
        select: ['id'],
        namespace
      });
      return row?.id === id;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  const affected = await config.database.updateMany({ model, where, data, namespace });
  return Number.isFinite(affected) && affected > 0;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof NotFoundError
    || Boolean(
      error
        && typeof error === 'object'
        && (error as { name?: unknown }).name === 'NotFoundError'
    );
}
