import { ADMIN_API_PREFIX, fetchAdmin, safeAdminDownloadHref, withAdminScope } from '$lib/components/admin-api';
import type { CiLogLineViewModel } from '$lib/components/view-models';
import type { PageLoad } from './$types';

interface CiLogCapabilities {
  follow?: boolean;
  download?: boolean;
}

interface CiLogResponse {
  lines?: CiLogLineViewModel[];
  items?: CiLogLineViewModel[];
  nextCursor?: string;
  capabilities?: CiLogCapabilities;
  followIntervalMs?: number;
  downloadHref?: string;
  downloadSignedExternal?: boolean;
}

export const load: PageLoad = async ({ fetch, params, depends, url }) => {
  const dependencyKey: `${string}:${string}` = `superconsole:cifn:run:${params.runId}:job:${params.jobKey}:logs`;
  depends(dependencyKey);
  const apiHref = `${ADMIN_API_PREFIX}/modules/cifn/runs/${encodeURIComponent(params.runId)}/jobs/${encodeURIComponent(params.jobKey)}/logs`;
  const request = new URL(apiHref, 'http://superconsole.local');
  for (const key of ['cursor', 'limit', 'tail']) {
    const value = url.searchParams.get(key);
    if (value) request.searchParams.set(key, value);
  }
  const result = await fetchAdmin<CiLogResponse>(
    fetch,
    withAdminScope(`${request.pathname}${request.search}`, url.searchParams)
  );
  const payload = result.ok ? result.data : undefined;
  const safeDownload = payload?.capabilities?.download
    ? safeAdminDownloadHref(payload.downloadHref, {
        origin: url.origin,
        signedExternal: payload.downloadSignedExternal === true,
      })
    : undefined;
  const downloadHref = safeDownload?.startsWith('/api/admin/')
    ? withAdminScope(safeDownload, url.searchParams)
    : safeDownload;

  return {
    runId: params.runId,
    jobKey: params.jobKey,
    lines: payload?.lines ?? payload?.items ?? [],
    nextCursor: payload?.nextCursor,
    followAvailable: payload?.capabilities?.follow === true,
    followIntervalMs: Math.max(1_000, Math.min(payload?.followIntervalMs ?? 3_000, 30_000)),
    downloadHref,
    dependencyKey,
    loadError: result.ok ? undefined : result.error,
  };
};
