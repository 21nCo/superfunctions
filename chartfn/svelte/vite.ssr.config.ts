import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
export default defineConfig({
  plugins: [svelte()],
  build: {
    ssr: "src/index.ts", outDir: "dist", emptyOutDir: false,
    rollupOptions: {
      external: (id) => id === "chartfn" || id === "svelte" || id.startsWith("svelte/"),
      output: { entryFileNames: "index.node.js" },
    },
  },
});
