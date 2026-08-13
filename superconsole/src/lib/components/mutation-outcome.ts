export interface SuccessfulMutationFeedback {
  ok: true;
  message: string;
  refreshed: boolean;
}

/**
 * Refreshing a view is a follow-up to a completed administration mutation.
 * A refresh failure must never rewrite the authoritative operation outcome or
 * invite a duplicate retry with a new idempotency key.
 */
export async function refreshSuccessfulMutation(
  message: string,
  refresh: () => Promise<unknown>
): Promise<SuccessfulMutationFeedback> {
  try {
    await refresh();
    return { ok: true, message, refreshed: true };
  } catch {
    return {
      ok: true,
      message: `${message} The view could not refresh; reload to see the latest state.`,
      refreshed: false,
    };
  }
}
