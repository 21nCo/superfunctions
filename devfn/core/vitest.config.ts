import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", include: ["test/**/*.test.ts"],
  // Real Caddy fixtures share its fixed admin and listener ports across files.
  fileParallelism: process.env.DEVFN_REAL_PROXY !== "1",
  // Sibling DevFn packages run through Vitest as they do from the workspace, so node: module mocks reach them when installed from the registry too.
  server: { deps: { inline: [/\/node_modules\/@devfn\//] } } } });
