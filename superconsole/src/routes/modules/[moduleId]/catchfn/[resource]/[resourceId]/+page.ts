import { loadResourceDetail } from '$lib/components/resource-pages';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, parent, url, depends }) => {
  depends(`superconsole:module:${params.moduleId}:source:catchfn:resource:${params.resource}:${params.resourceId}`);
  const { shell } = await parent();
  return loadResourceDetail({ fetcher: fetch, url, registry: shell.registry, moduleId: params.moduleId, sourceModuleId: 'catchfn', resourceId: params.resource, identity: params.resourceId });
};
