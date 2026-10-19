import { docsSiteCorePlugin } from "../../scripts/docs-site/vite";
import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, type PluginOption } from "vite";

export default defineConfig({
  plugins: [docsSiteCorePlugin(import.meta.url), tailwindcss(), sveltekit()] satisfies PluginOption[],
  ssr: {
    // Declared consumer peers resolve public exports; Turbo prepares workspace dist.
    noExternal: ["@docsfn/core", "@docsfn/svelte"],
  },
});
