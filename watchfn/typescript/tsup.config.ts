import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/adapters/express.ts", "src/adapters/fastify.ts", "src/adapters/hono.ts", "src/adapters/next.ts", "src/adapters/sveltekit.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  minify: false,
  sourcemap: true,
  treeshake: true,
  // Bundle the shared implementation so Node 18 CommonJS consumers do not
  // synchronously require ESM-only dependency entry points.
  noExternal: [
    "@logfn/core",
    "@superfunctions/auth",
    "@superfunctions/db",
    "@superfunctions/http",
    "@superfunctions/observability",
    "@superfunctions/http-express",
    "@superfunctions/http-fastify",
    "@superfunctions/http-hono",
    "@superfunctions/http-next",
    "@superfunctions/http-sveltekit",
  ],
});
