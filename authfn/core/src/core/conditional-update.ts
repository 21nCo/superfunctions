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
  return (await updateRowOutcome(config, model, id, guards, data)) === 'applied';
}

/**
 * Like updateRowIfMatches, but tells a confirmed no-op (`'not-applied'`: no
 * row matched) from a write whose outcome the adapter could not report
 * (`'unknown'`, for example a count of NaN), which may have applied.
 */
export async function updateRowOutcome(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  model: string,
  id: string,
  guards: WhereClause[],
  data: Record<string, unknown>
): Promise<'applied' | 'not-applied' | 'unknown'> {
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
      return row?.id === id ? 'applied' : 'unknown';
    } catch (error) {
      if (isNotFoundError(error)) {
        return 'not-applied';
      }
      throw error;
    }
  }

  const affected = await config.database.updateMany({ model, where, data, namespace });
  if (affected === 0) {
    return 'not-applied';
  }
  return Number.isFinite(affected) && affected > 0 ? 'applied' : 'unknown';
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof NotFoundError
    || Boolean(
      error
        && typeof error === 'object'
        && (error as { name?: unknown }).name === 'NotFoundError'
    );
}
