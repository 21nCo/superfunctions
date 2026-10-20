import type { Page, Request } from 'playwright';
import { createProbefnError } from '@probefn/contracts/errors';

export interface ActionSettlementOptions {
  /** Quiet period after requests started during the action finish. Default 100 ms. */
  networkIdleMs?: number;
  /** Maximum settlement wait after the action returns. Default 5000 ms. */
  settleTimeoutMs?: number;
  /** Await the session's event persistence before reading delta counters. */
  flushEvents?: () => Promise<void>;
}

export function validateActionSettlement(options: ActionSettlementOptions): void {
  const quiet = options.networkIdleMs ?? 100;
  const timeout = options.settleTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(quiet) || quiet < 0 || !Number.isSafeInteger(timeout) || timeout < 1 || quiet >= timeout) {
    throw createProbefnError({ code: 'E_CONFIG_INVALID', message: 'Action settlement requires 0 <= networkIdleMs < settleTimeoutMs.', retryable: false });
  }
}

/** Observe requests before performing the action so fast failures cannot escape the barrier. */
export async function settleAction(page: Page, options: ActionSettlementOptions, perform: () => Promise<void>): Promise<void> {
  validateActionSettlement(options);
  const pending = new Set<Request>();
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let complete: (() => void) | undefined;
  const arm = () => {
    clearTimeout(quietTimer);
    if (complete && pending.size === 0) quietTimer = setTimeout(complete, options.networkIdleMs ?? 100);
  };
  const started = (request: Request) => { pending.add(request); arm(); };
  const finished = (request: Request) => { pending.delete(request); arm(); };
  page.on('request', started);
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);
  try {
    await perform();
    await new Promise<void>((resolve, reject) => {
      complete = resolve;
      deadline = setTimeout(() => reject(createProbefnError({
        code: 'E_ACTION_SETTLE_TIMEOUT',
        message: 'The action executed but its network activity did not settle before the deadline.',
        retryable: false,
        details: { actionMayHaveExecuted: true, pendingRequests: pending.size },
      })), options.settleTimeoutMs ?? 5000);
      arm();
    });
    await options.flushEvents?.();
  } finally {
    clearTimeout(quietTimer);
    clearTimeout(deadline);
    page.off('request', started);
    page.off('requestfinished', finished);
    page.off('requestfailed', finished);
  }
}
