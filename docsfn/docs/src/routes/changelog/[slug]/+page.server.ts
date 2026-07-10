import { error } from "@sveltejs/kit";
import { getCollectionPostData } from "@docsfn/sveltekit";
import { getCompiledDocsPost } from "$lib/server/docs-site-source";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, parent }) => {
  const { source } = await parent();
  const post = getCollectionPostData("changelog", params.slug, source.manifest);

  if (!post || post.draft) {
    throw error(404, "Changelog entry not found");
  }

  const compiled = await getCompiledDocsPost(post.id);

  return {
    collection: source.manifest.collections?.changelog,
    post,
    compiled,
    siteTitle: source.siteTitle,
  };
};
