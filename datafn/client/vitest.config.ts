import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@datafn/swift-bridge": fileURLToPath(
        new URL("../swift-bridge/src/index.ts", import.meta.url),
      ),
      // The KV two-device tests run against the server source. @datafn/server
      // already dev-depends on @datafn/client, so the client cannot declare it
      // back without a package cycle, and a source alias needs no server build.
      // turbo.json builds the workspace packages the server source loads and
      // keys the test cache on the server source.
      "@datafn/server": fileURLToPath(
        new URL("../server/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: "node",
  },
});
