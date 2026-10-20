import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/storage/event-indexes-sqlite.acceptance.ts"], testTimeout: 15000 } });
