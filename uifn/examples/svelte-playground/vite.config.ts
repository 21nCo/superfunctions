import path from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "vite";

const { svelte, vitePreprocess } = await import(
  pathToFileURL(
    path.resolve(__dirname, "../../svelte/node_modules/@sveltejs/vite-plugin-svelte/src/index.js"),
  ).href,
);

export default defineConfig({
  plugins: [
    svelte({
      preprocess: vitePreprocess(),
    }),
  ],
  resolve: {
    alias: [
      {
        find: /^svelte$/,
        replacement: path.resolve(__dirname, "../../../node_modules/svelte/src/index-client.js"),
      },
      {
        find: "@uifn/svelte",
        replacement: path.resolve(__dirname, "../../svelte/dist/index.mjs"),
      },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 6112,
  },
  preview: {
    host: "127.0.0.1",
    port: 6112,
  },
});
