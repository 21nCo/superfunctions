import { resolve } from "node:path";

export default {
  resolve: {
    alias: {
      "@superfunctions/auth": resolve(__dirname, "../../packages/auth/src/index.ts"),
      "@superfunctions/http": resolve(__dirname, "../../packages/http/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
};
