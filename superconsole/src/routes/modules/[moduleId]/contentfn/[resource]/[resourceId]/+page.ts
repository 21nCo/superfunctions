import { loadResourceDetail } from '$lib/components/resource-pages';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, parent, url, depends }) => {
  depends(`superconsole:module:${params.moduleId}:source:contentfn:resource:${params.resource}:${params.resourceId}`);
  const { shell } = await parent();
  return loadResourceDetail({ fetcher: fetch, url, registry: shell.registry, moduleId: params.moduleId, sourceModuleId: 'contentfn', resourceId: params.resource, identity: params.resourceId });
};
