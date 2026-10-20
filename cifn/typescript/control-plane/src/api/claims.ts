import type { Hono } from 'hono';
import type { ControlPlaneStore } from '../store/store.js';
import type { DatabaseStore } from '../store/database-store.js';
import { compareSecretHash } from '../runners/crypto.js';
import { readJsonBody, PayloadTooLargeError } from './body.js';
import { ClaimConflictError, validateCompletion, type ClaimIdentity } from '../dispatch/types.js';
import { success, error } from './envelope.js';

export function registerClaimRoutes(api: Hono, store: ControlPlaneStore): void {
  for (const action of ['resume', 'ack', 'complete', 'status', 'stopped'] as const) {
    api.post(`/runners/claims/${action}`, async c => {
      let body: Record<string, unknown>;
      try { body = await readJsonBody(c.req.raw); }
      catch (cause) { return c.json(error('BAD_REQUEST', 'Invalid claim request'), cause instanceof PayloadTooLargeError ? 413 : 400); }
      const bearer = c.req.header('Authorization');
      if (typeof body.runnerId !== 'string' || !bearer?.startsWith('Bearer ')) return c.json(error('UNAUTHORIZED', 'Runner authentication required'), 401);
      const runner = await store.getRunner(body.runnerId);
      if (!runner || !compareSecretHash(bearer.slice(7), runner.secretHash)) return c.json(error('UNAUTHORIZED', 'Invalid runner authentication'), 401);
      const durable = store as DatabaseStore;
      if (typeof durable.completeDispatch !== 'function') return c.json(error('UNAVAILABLE', 'Durable claim protocol unavailable'), 503);
      try {
        if (action === 'resume') {
          if (body.cursor !== undefined && typeof body.cursor !== 'string') return c.json(error('BAD_REQUEST', 'Invalid cursor'), 400);
          return c.json(success(await durable.listRunnerClaims(runner.id, body.cursor as string | undefined)));
        }
        for (const field of ['runId', 'dispatchId', 'claimToken', 'executionId']) {
          if (typeof body[field] !== 'string' || !body[field] || (body[field] as string).length > 512) return c.json(error('BAD_REQUEST', 'Invalid claim identity'), 400);
        }
        const identity: ClaimIdentity = { runId: body.runId as string, dispatchId: body.dispatchId as string, claimToken: body.claimToken as string, executionId: body.executionId as string, runnerId: runner.id };
        if (action === 'status') return c.json(success(await durable.observeDispatch(identity)));
        if (action === 'stopped') return c.json(success(await durable.acknowledgeCancellation(identity)));
        if (action === 'ack') { await durable.acknowledgeDispatch(identity); return c.json(success({ acknowledged: true })); }
        if (!validateCompletion(body.result)) return c.json(error('BAD_REQUEST', 'Invalid terminal job result'), 400);
        return c.json(success(await durable.completeDispatch(identity, body.result)));
      } catch (cause) {
        if (cause instanceof ClaimConflictError) return c.json(error('CLAIM_CONFLICT', cause.message), 409);
        return c.json(error('UNAVAILABLE', 'Durable claim operation failed'), 503);
      }
    });
  }
}
