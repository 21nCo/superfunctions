import { resolveEmbedMode } from "@docsfn/sveltekit";
import { loadDocsSiteSource } from "$lib/server/docs-site-source";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ url }) => {
  return {
    embed: resolveEmbedMode(url),
    source: await loadDocsSiteSource(),
  };
};
