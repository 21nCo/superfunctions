import { defineConfig } from "vitest/config";
// The panel tests build git fixtures and snapshots; allow for a loaded CI or review host.
export default defineConfig({ test: { environment: "node", include: ["test/**/*.test.ts"], testTimeout: 30_000 } });
