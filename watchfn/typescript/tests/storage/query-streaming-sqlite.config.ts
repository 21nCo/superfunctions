import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/storage/query-streaming-sqlite.acceptance.ts"], testTimeout: 30000 } });
