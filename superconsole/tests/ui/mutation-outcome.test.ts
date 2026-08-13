import { describe, expect, it, vi } from 'vitest';
import { refreshSuccessfulMutation } from '../../src/lib/components/mutation-outcome';

describe('completed administration mutations', () => {
  it('keeps a completed mutation successful when its follow-up refresh fails', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('navigation unavailable'));

    await expect(refreshSuccessfulMutation('Policy updated. Audit audit-1.', refresh)).resolves.toEqual({
      ok: true,
      message: 'Policy updated. Audit audit-1. The view could not refresh; reload to see the latest state.',
      refreshed: false,
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('reports a successful refresh without changing the operation receipt', async () => {
    await expect(refreshSuccessfulMutation('Run cancelled. Request req-1.', async () => undefined)).resolves.toEqual({
      ok: true,
      message: 'Run cancelled. Request req-1.',
      refreshed: true,
    });
  });
});
