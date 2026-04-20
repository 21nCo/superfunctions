import type { DocsConfig } from "@docsfn/core";

const config: DocsConfig = {
  schemaVersion: 1,
  site: {
    title: "docsfn",
    description: "The documentation toolchain for superfunctions",
    basePath: "/docs",
    canonicalUrl: "https://docsfn.superfunctions.dev",
    showFooter: false,
    editLink: {
      pattern: "https://github.com/21nCo/super-functions/edit/dev/docsfn/docs/{path}",
    },
  },
  compat: { preset: "none" },
  content: {
    root: ".",
    docsDir: "content/docs",
    blogDir: "content/blog",
    apiDir: "content/api",
    pagesDir: "content/pages",
    assetsDir: "static",
    metaFileName: "meta.json",
  },
  navigation: {
    topNav: [
      { label: "Docs", href: "/docs" },
      { label: "API Reference", href: "/docs/api" },
      { label: "Blog", href: "/blog" },
      {
        label: "GitHub",
        href: "https://github.com/21nCo/super-functions/tree/dev/docsfn",
        external: true,
      },
    ],
    sidebars: {
      docs: { title: "Documentation", root: true, include: ["docs/**"] },
      api: { title: "API Reference", root: true, include: ["docs/api/**"] },
    },
  },
  search: {
    enabled: true,
    scopes: ["docs", "api", "blog"],
    bodyIndexing: "summary",
    routeScopeOverrides: [
      { pattern: "/docs/api", scope: "api" },
      { pattern: "/docs/api/**", scope: "api" },
    ],
  },
  auth: { enabled: false, mode: "public" },
  analytics: { enabled: false, provider: "watchfn", respectDnt: true },
};

export default config;
