import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      {
        find: /^@uifn\/core\/(.*)$/,
        replacement: `${path.resolve(__dirname, "../../core/src")}/$1`,
      },
      {
        find: "@uifn/vue",
        replacement: path.resolve(__dirname, "../../vue/src/index.ts"),
      },
      {
        find: "@uifn/examples-shared",
        replacement: path.resolve(__dirname, "../shared/src/index.ts"),
      },
      {
        find: "@uifn/core",
        replacement: path.resolve(__dirname, "../../core/src/index.ts"),
      },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 6113,
  },
  preview: {
    host: "127.0.0.1",
    port: 6113,
  },
});
