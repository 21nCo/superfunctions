import { fetchAdmin } from '$lib/components/admin-api';
import { ciRunListAdminHref } from '$lib/components/cifn';
import { moduleById, type CiRunViewModel } from '$lib/components/view-models';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, parent, url, depends }) => {
  depends('superconsole:cifn:runs');
  const { shell } = await parent();
  const module = moduleById(shell.registry, 'cifn');
  if (!module) {
    return {
      module: undefined,
      runs: [],
      loadError: { status: 404, code: 'MODULE_NOT_ENABLED', message: 'CiFn is not enabled for this deployment.' },
    };
  }
  const result = await fetchAdmin<{ runs?: CiRunViewModel[]; items?: CiRunViewModel[]; nextCursor?: string }>(
    fetch,
    ciRunListAdminHref(url.searchParams)
  );
  return {
    module,
    runs: result.ok ? result.data.runs ?? result.data.items ?? [] : [],
    nextCursor: result.ok ? result.data.nextCursor ?? result.page?.nextCursor ?? undefined : undefined,
    loadError: result.ok ? undefined : result.error,
    status: url.searchParams.get('status') ?? '',
  };
};
