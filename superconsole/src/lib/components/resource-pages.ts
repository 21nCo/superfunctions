import { ADMIN_API_PREFIX, fetchAdmin, materializeAdminActionHref, withAdminScope, type AdminFetch } from './admin-api';
import {
  inferAdminResourceColumns,
  inferAdminResourceFields,
  inferAdminResourceStatus,
  inferAdminResourceTitle,
  isAdminRecord,
  moduleById,
  normalizeAdminResourceRows,
  readAdminPresentationField,
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

function detailInput(
  resource: AdminResourceViewModel,
  identity: string,
  searchParams: URLSearchParams
): { value?: Record<string, unknown>; missing?: string } {
  const idInput = resource.detailIdInput ?? 'id';
  const value: Record<string, unknown> = { [idInput]: identity };
  const schema = resource.detailInputSchema;
  const required = schema?.type === 'object' ? schema.required ?? [] : [];
  for (const key of required) {
    if (key === idInput) continue;
    const raw = searchParams.get(key);
    if (raw === null || raw === '') return { missing: key };
    const property = schema?.type === 'object' ? schema.properties?.[key] : undefined;
    if (!property || property.type === 'string') {
      value[key] = raw;
      continue;
    }
    try {
      value[key] = JSON.parse(raw);
    } catch {
      return { missing: key };
    }
  }
  return { value };
}

export async function loadResourceList(input: ResourceRouteInput): Promise<{
  view?: ResourceListViewModel;
  loadError?: AdminErrorViewModel;
  query: string;
}> {
  const module = moduleById(input.registry, input.moduleId);
  const resource = resourceForRoute(module?.resources, input.resourceId, input.sourceModuleId);
  if (!module || !resource) return { view: undefined, loadError: unavailable(input.resourceId, input.moduleId), query: '' };

  const apiModule = input.sourceModuleId ?? resource.sourceModuleId ?? input.moduleId;
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
  // List operations own global ordering because cursor pagination must be sorted before slicing.
  // Preserve the provider's order unless the operation contract explicitly accepts a sort input.
  const canonicalItems = Array.isArray(payload.items) ? payload.items : [];
  const explicitRows = Array.isArray(payload.rows) ? payload.rows : undefined;
  const columnSource = explicitRows?.map((row) => ({ values: row.values })) ?? canonicalItems;
  const columns = resource.presentation?.columns?.length
    ? resource.presentation.columns.map((column) => ({ key: column.field, label: column.label, format: column.format }))
    : Array.isArray(payload.columns) && payload.columns.length
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

  const apiModule = input.sourceModuleId ?? resource.sourceModuleId ?? input.moduleId;
  const canonicalResource = resource.resourceId ?? input.resourceId;
  const detailTemplate = resource.detailApiHref;
  if (!detailTemplate) return { view: undefined, loadError: unavailable(input.resourceId, input.moduleId) };
  const operationInput = detailInput(resource, input.identity, input.url.searchParams);
  if (!operationInput.value) {
    return {
      view: undefined,
      loadError: {
        status: 400,
        code: 'RESOURCE_DETAIL_INPUT_REQUIRED',
        message: `${operationInput.missing ?? 'A required identifier'} is required to load this ${canonicalResource} detail.`,
      },
    };
  }
  const base = materializeAdminActionHref(detailTemplate, operationInput.value, 'GET');
  if (!base) return { view: undefined, loadError: unavailable(input.resourceId, input.moduleId) };
  const result = await fetchAdmin<Partial<ResourceDetailViewModel> & { item?: unknown }>(
    input.fetcher,
    withAdminScope(base, input.url.searchParams)
  );
  const payload = result.ok ? result.data : {};
  const itemRecord = isAdminRecord(payload.item) ? payload.item : undefined;
  const presentation = resource.presentation;
  const fieldValue = (field: string | undefined): unknown =>
    field && itemRecord ? readAdminPresentationField(itemRecord, field) : undefined;
  const presentedTitle = fieldValue(presentation?.titleField);
  const presentedSubtitle = fieldValue(presentation?.subtitleField);
  const presentedStatus = fieldValue(presentation?.statusField);
  const presentedFields = presentation?.columns?.map((column) => ({
    label: column.label,
    value: fieldValue(column.field),
    format: column.format,
  }));
  return {
    view: {
      module,
      resource,
      id: input.identity,
      title: typeof presentedTitle === 'string' || typeof presentedTitle === 'number'
        ? String(presentedTitle)
        : payload.title ?? inferAdminResourceTitle(itemRecord, input.identity),
      subtitle: typeof presentedSubtitle === 'string'
        ? presentedSubtitle
        : payload.subtitle ?? (typeof itemRecord?.description === 'string' ? itemRecord.description : undefined),
      status: typeof presentedStatus === 'string'
        ? presentedStatus
        : payload.status ?? inferAdminResourceStatus(itemRecord),
      fields: presentedFields?.length
        ? presentedFields
        : Array.isArray(payload.fields) ? payload.fields : inferAdminResourceFields(itemRecord),
      actions: (resource.actions ?? []).filter((action) => Boolean(action.targetIdInput)).map((action) => ({
        ...action,
        input: { ...(action.input ?? {}), [action.targetIdInput!]: input.identity },
      })),
      audit: Array.isArray(payload.audit) ? payload.audit : [],
    },
    loadError: result.ok ? undefined : result.error,
  };
}
