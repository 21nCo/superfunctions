import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"], passWithNoTests: false, testTimeout: 10_000 } });
