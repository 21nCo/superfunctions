import path from "path";
import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const reactRoot = path.dirname(require.resolve("react/package.json"));
const reactDomRoot = path.dirname(require.resolve("react-dom/package.json"));

export default defineConfig({
  resolve: {
    alias: {
      react: reactRoot,
      "react-dom": reactDomRoot,
      "react/jsx-runtime": path.join(reactRoot, "jsx-runtime.js"),
      "react/jsx-dev-runtime": path.join(reactRoot, "jsx-dev-runtime.js"),
    },
    dedupe: ["react", "react-dom"],
  },
  esbuild: {
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
  },
  test: {
    globals: true,
    environment: "jsdom",
  },
});
