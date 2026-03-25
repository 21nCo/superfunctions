import { error } from "@sveltejs/kit";
import { compileSvelteContent } from "@docsfn/core";
import { getPostData } from "@docsfn/sveltekit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, parent }) => {
  const { source } = await parent();
  const post = getPostData(params.slug, source.manifest);

  if (!post || post.draft) {
    throw error(404, "Post not found");
  }

  const compiled = compileSvelteContent({
    source: post.body,
    compatPreset: source.compatPreset,
  });

  return {
    post,
    compiled,
    siteTitle: source.siteTitle,
  };
};
