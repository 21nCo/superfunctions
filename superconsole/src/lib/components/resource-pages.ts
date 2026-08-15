import { ADMIN_API_PREFIX, fetchAdmin, materializeAdminApiHref, withAdminScope, type AdminFetch } from './admin-api';
import {
  inferAdminResourceColumns,
  inferAdminResourceFields,
  inferAdminResourceStatus,
  inferAdminResourceTitle,
  isAdminRecord,
  moduleById,
  normalizeAdminResourceRows,
  type AdminErrorViewModel,
  type AdminResourceViewModel,
  type RegistryViewModel,
  type ResourceDetailViewModel,
  type ResourceListViewModel,
} from './view-models';

interface ResourceRouteInput {
  fetcher: AdminFetch;
  url: URL;
  registry: RegistryViewModel;
  moduleId: string;
  resourceId: string;
  sourceModuleId?: string;
}

function resourceForRoute(
  resources: AdminResourceViewModel[] | undefined,
  resourceId: string,
  sourceModuleId?: string
): AdminResourceViewModel | undefined {
  return resources?.find((candidate) => {
    const canonicalId = candidate.resourceId ?? candidate.id;
    if (sourceModuleId) {
      return candidate.sourceModuleId?.toLowerCase() === sourceModuleId.toLowerCase()
        && canonicalId.toLowerCase() === resourceId.toLowerCase();
    }
    return candidate.id.toLowerCase() === resourceId.toLowerCase()
      || (!candidate.foldedIntoModuleId && canonicalId.toLowerCase() === resourceId.toLowerCase());
  });
}

function unavailable(resourceId: string, moduleId: string): AdminErrorViewModel {
  return {
    status: 404,
    code: 'RESOURCE_NOT_ENABLED',
    message: `${resourceId} is not an enabled ${moduleId} administration resource.`,
  };
}

export async function loadResourceList(input: ResourceRouteInput): Promise<{
  view?: ResourceListViewModel;
  loadError?: AdminErrorViewModel;
  query: string;
}> {
  const module = moduleById(input.registry, input.moduleId);
  const resource = resourceForRoute(module?.resources, input.resourceId, input.sourceModuleId);
  if (!module || !resource) return { view: undefined, loadError: unavailable(input.resourceId, input.moduleId), query: '' };

  const apiModule = input.sourceModuleId ?? input.moduleId;
  const canonicalResource = resource.resourceId ?? input.resourceId;
  if (resource.listable === false) {
    return { view: undefined, loadError: unavailable(input.resourceId, input.moduleId), query: '' };
  }
  const apiHref = resource.listApiHref ?? resource.apiHref
    ?? `${ADMIN_API_PREFIX}/modules/${encodeURIComponent(apiModule)}/${encodeURIComponent(canonicalResource)}`;
  const requestHref = new URL(apiHref, 'http://superconsole.local');
  for (const [key, value] of input.url.searchParams) requestHref.searchParams.set(key, value);
  const result = await fetchAdmin<Partial<ResourceListViewModel> & { items?: unknown[] }>(
    input.fetcher,
    withAdminScope(`${requestHref.pathname}${requestHref.search}`, input.url.searchParams)
  );
  const payload = result.ok ? result.data : {};
  const canonicalItems = Array.isArray(payload.items) ? payload.items : [];
  const explicitRows = Array.isArray(payload.rows) ? payload.rows : undefined;
  const columnSource = explicitRows?.map((row) => ({ values: row.values })) ?? canonicalItems;
  const columns = Array.isArray(payload.columns) && payload.columns.length
    ? payload.columns
    : inferAdminResourceColumns(columnSource);
  return {
    view: {
      module,
      resource,
      columns,
      rows: explicitRows ?? normalizeAdminResourceRows(canonicalItems, columns, resource),
      total: payload.total,
      nextCursor: payload.nextCursor ?? (result.ok ? result.page?.nextCursor ?? undefined : undefined),
    },
    loadError: result.ok ? undefined : result.error,
    query: input.url.searchParams.get('q') ?? '',
  };
}

export async function loadResourceDetail(
  input: ResourceRouteInput & { identity: string }
): Promise<{ view?: ResourceDetailViewModel; loadError?: AdminErrorViewModel }> {
  const module = moduleById(input.registry, input.moduleId);
  const resource = resourceForRoute(module?.resources, input.resourceId, input.sourceModuleId);
  if (!module || !resource) return { view: undefined, loadError: unavailable(input.resourceId, input.moduleId) };

  const apiModule = input.sourceModuleId ?? input.moduleId;
  const canonicalResource = resource.resourceId ?? input.resourceId;
  const defaultBase = `${ADMIN_API_PREFIX}/modules/${encodeURIComponent(apiModule)}/${encodeURIComponent(canonicalResource)}`;
  const detailTemplate = resource.detailApiHref;
  const base = detailTemplate
    ? materializeAdminApiHref(detailTemplate, { [resource.detailIdInput ?? 'id']: input.identity })
    : `${resource.apiHref ?? defaultBase}/${encodeURIComponent(input.identity)}`;
  if (!base) return { view: undefined, loadError: unavailable(input.resourceId, input.moduleId) };
  const result = await fetchAdmin<Partial<ResourceDetailViewModel> & { item?: unknown }>(
    input.fetcher,
    withAdminScope(base, input.url.searchParams)
  );
  const payload = result.ok ? result.data : {};
  const itemRecord = isAdminRecord(payload.item) ? payload.item : undefined;
  return {
    view: {
      module,
      resource,
      id: input.identity,
      title: payload.title ?? inferAdminResourceTitle(itemRecord, input.identity),
      subtitle: payload.subtitle ?? (typeof itemRecord?.description === 'string' ? itemRecord.description : undefined),
      status: payload.status ?? inferAdminResourceStatus(itemRecord),
      fields: Array.isArray(payload.fields) ? payload.fields : inferAdminResourceFields(itemRecord),
      actions: (resource.actions ?? []).filter((action) => Boolean(action.targetIdInput)).map((action) => ({
        ...action,
        input: { ...(action.input ?? {}), [action.targetIdInput!]: input.identity },
      })),
      audit: Array.isArray(payload.audit) ? payload.audit : [],
    },
    loadError: result.ok ? undefined : result.error,
  };
}
