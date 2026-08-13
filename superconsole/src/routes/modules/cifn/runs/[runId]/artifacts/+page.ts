import { ADMIN_API_PREFIX, fetchAdmin, safeAdminDownloadHref, withAdminScope } from '$lib/components/admin-api';
import type { CiArtifactViewModel } from '$lib/components/view-models';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, depends, url }) => {
  depends(`superconsole:cifn:run:${params.runId}:artifacts`);
  const result = await fetchAdmin<{ artifacts?: CiArtifactViewModel[]; items?: CiArtifactViewModel[] }>(
    fetch,
    withAdminScope(
      `${ADMIN_API_PREFIX}/modules/cifn/runs/${encodeURIComponent(params.runId)}/artifacts`,
      url.searchParams
    )
  );
  const artifacts = result.ok ? result.data.artifacts ?? result.data.items ?? [] : [];
  return {
    runId: params.runId,
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      url: safeAdminDownloadHref(artifact.url, {
        origin: url.origin,
        signedExternal: artifact.signedExternal === true,
      }),
    })),
    loadError: result.ok ? undefined : result.error,
  };
};
