import { searchfnAdapterVitestConfig } from "../adapter-contracts/adapter-vitest.config";

export default searchfnAdapterVitestConfig({
  test: {
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    exclude: ["__tests__/workerd/**"],
    // The legacy suites share the public schema and wipe each other's tables; run files one at a time.
    fileParallelism: false,
  },
});
