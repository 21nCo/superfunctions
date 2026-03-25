import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const svelteSrc = path.resolve(dirname, "../svelte/src");

const coreSrc = path.resolve(dirname, "../core/src");

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  resolve: {
    alias: {
      "@docsfn/core/search-runtime": path.join(coreSrc, "search-runtime.ts"),
      "@docsfn/core/search": path.join(coreSrc, "search.ts"),
      "@docsfn/core/analytics": path.join(coreSrc, "analytics.ts"),
      "@docsfn/core/browser": path.join(coreSrc, "browser.ts"),
      "@site/docs-content": path.join(svelteSrc, "DocsContent.svelte"),
      "@site/docs-layout": path.join(svelteSrc, "DocsLayout.svelte"),
      "@site/topbar": path.join(svelteSrc, "TopBar.svelte"),
      "@site/breadcrumbs": path.join(svelteSrc, "Breadcrumbs.svelte"),
      "@site/pagination": path.join(svelteSrc, "Pagination.svelte"),
      "@site/docs-sidebar": path.join(svelteSrc, "DocsSidebar.svelte"),
      "@site/docs-toc": path.join(svelteSrc, "DocsToc.svelte"),
      "@site/api-reference-renderer": path.join(svelteSrc, "ApiReferenceRenderer.svelte"),
      "@site/docs-search": path.join(svelteSrc, "DocsSearch.svelte"),
    },
  },
});
