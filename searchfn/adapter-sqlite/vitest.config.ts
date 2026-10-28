import { searchfnAdapterVitestConfig } from "../adapter-contracts/adapter-vitest.config";

export default searchfnAdapterVitestConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    exclude: ["__tests__/workerd/**"],
    testTimeout: 30_000,
  },
});
