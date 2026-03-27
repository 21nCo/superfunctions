import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      drawfn: path.resolve(__dirname, "..", "core", "src", "index.ts"),
      react: path.resolve(__dirname, "..", "..", "node_modules", "react"),
      "react-dom": path.resolve(
        __dirname,
        "..",
        "..",
        "node_modules",
        "react-dom"
      ),
      "react/jsx-runtime": path.resolve(
        __dirname,
        "..",
        "..",
        "node_modules",
        "react",
        "jsx-runtime.js"
      ),
      "react/jsx-dev-runtime": path.resolve(
        __dirname,
        "..",
        "..",
        "node_modules",
        "react",
        "jsx-dev-runtime.js"
      ),
    },
    dedupe: ["react", "react-dom"],
  },
  esbuild: {
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
  },
});
