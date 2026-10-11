import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    // Load built workspace dependencies through Node instead of Vite so
    // @apifn/core's optional dynamic imports are not resolved eagerly.
    server: { deps: { external: [/apifn\/core\/dist/, /packages\/http-openapi\/dist/] } },
  },
});
