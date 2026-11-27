import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Tests read catchfn from its workspace source, not the registry: catchfn 0.1.0 is unpublished,
      // and a devDependency on it would break `npm install` run in this package on its own.
      { find: /^catchfn$/, replacement: path.resolve(dirname, "../../catchfn/typescript/src/index.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
