import type { EcosystemEntry } from "./package-catalog";

const repoBranch = "dev";

function repoPath(path: string): string {
  return `https://github.com/21nCo/super-functions/tree/${repoBranch}/${path}`;
}

function createEntry(slug: string, title: string, summary: string): EcosystemEntry {
  return {
    slug,
    title,
    summary,
    href: repoPath(slug),
    hrefKind: "repo-path",
  };
}

export const ecosystemCatalog: readonly EcosystemEntry[] = [
  createEntry("authfn", "AuthFn", "Authentication and API key tooling for apps and services."),
  createEntry("cachefn", "CacheFn", "Multi-tier caching helpers for browser and server workloads."),
  createEntry("drawfn", "DrawFn", "Cross-framework drawing canvas primitives for collaborative UIs."),
  createEntry("plugfn", "PlugFn", "OAuth and webhook integration platform for third-party providers."),
  createEntry("searchfn", "SearchFn", "Browser-first full-text search with IndexedDB persistence."),
  createEntry("secfn", "SecFn", "Secrets, access control, rate limiting, and security utilities."),
  createEntry("testfn", "TestFn", "Testing helpers and framework integrations for Superfunctions packages."),
  createEntry("botfn", "BotFn", "Bot framework for GitHub, Discord, Linear, and other event-driven integrations."),
  createEntry("hostfn", "HostFn", "Hosting and deployment helpers for shipping Superfunctions-powered services."),
  createEntry("uifn", "UiFn", "UI components and utilities for product and admin interfaces."),
  createEntry("watchfn", "WatchFn", "File watching and monitoring utilities for local and hosted runtimes."),
  createEntry("billfn", "BillFn", "Billing and payment workflows for usage-based and subscription products."),
  createEntry("browsefn", "BrowseFn", "Browser automation building blocks for scripts, agents, and tests."),
  createEntry("chartfn", "ChartFn", "Charting and visualization utilities for product and analytics surfaces."),
  createEntry("datafn", "DataFn", "Data processing functions for ingestion, transformations, and access layers."),
  createEntry("docsfn", "DocsFn", "Documentation generation and publishing helpers for developer-facing products."),
  createEntry("filefn", "FileFn", "File operations and storage-oriented workflows built on shared primitives."),
  createEntry("flowfn", "FlowFn", "Queues, streams, and workflow control utilities for asynchronous systems."),
  createEntry("iconfn", "IconFn", "Icon libraries and asset tooling for design systems and apps."),
  createEntry("logfn", "LogFn", "Logging primitives and pipelines for application and integration telemetry."),
  createEntry("mailfn", "MailFn", "Programmable real inboxes for products, agents, and deterministic email testing."),
  createEntry("sendfn", "SendFn", "Email and messaging delivery helpers for notifications and campaigns."),
];
