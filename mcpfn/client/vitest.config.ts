import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Source tests run on Node.js, where package.json `imports` maps
    // `#stdio-target` to the built stdio entry; use its source instead.
    alias: { "#stdio-target": fileURLToPath(new URL("./src/stdio.ts", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/global-setup.ts"],
  },
});
