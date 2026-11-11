import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", include: ["test/**/*.test.ts"],
  // Fail any test file or run that leaves a process running or a temp entry behind.
  globalSetup: ["../test-support/leak-guard.mjs"], setupFiles: ["./test/leak-guard.setup.ts"] } });
