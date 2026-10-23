import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  minify: false,
  sourcemap: true,
  treeshake: true,
  noExternal: [
    "@superfunctions/http-express",
    "@superfunctions/http-fastify",
    "@superfunctions/http-hono",
    "@superfunctions/http-next",
    "@superfunctions/http-sveltekit",
  ],
});
