import { defineConfig } from "@solidjs/start/config";

export default defineConfig({
  ssr: false,
  server: {
    baseURL: "/components/solid",
    preset: "static",
    compatibilityDate: "2026-07-16",
  },
  vite: {
    build: {
      modulePreload: {
        resolveDependencies: (_filename, dependencies) => dependencies.map(
          (dependency) => dependency.startsWith("_build/")
            ? dependency
            : `_build/${dependency}`,
        ),
      },
    },
    server: {
      fs: {
        allow: ["../../.."],
      },
    },
  },
});
