import { ADMIN_API_PREFIX, fetchAdmin, withAdminScope } from '$lib/components/admin-api';
import type { CiRunViewModel } from '$lib/components/view-models';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, depends, url }) => {
  depends(`superconsole:cifn:run:${params.runId}`);
  const result = await fetchAdmin<CiRunViewModel | { item?: CiRunViewModel; run?: CiRunViewModel }>(
    fetch,
    withAdminScope(
      `${ADMIN_API_PREFIX}/modules/cifn/runs/${encodeURIComponent(params.runId)}`,
      url.searchParams
    )
  );
  const payload = result.ok ? result.data : undefined;
  const run = payload && 'runId' in payload
    ? payload
    : payload?.run ?? payload?.item;
  return {
    run,
    runId: params.runId,
    loadError: result.ok ? undefined : result.error,
  };
};
