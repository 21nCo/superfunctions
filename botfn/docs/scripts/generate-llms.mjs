#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLlmsTxtArtifacts, buildManifest, loadDocsConfig } from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";
import { buildLlmsSiteArtifacts, writeLlmsArtifacts } from "../../../scripts/docs-site/llms.mjs";

/**
 * Keep LLM indexes navigable before a public documentation host is assigned.
 * @param {string} text
 * @param {import("@docsfn/core").DocsManifest} manifest
 * @param {string | undefined} canonicalUrl
 */
function withSourceLinks(text, manifest, canonicalUrl) {
  if (canonicalUrl) return text;
  const sources = new Map(Object.values(manifest.pages)
    .filter((page) => page.id.startsWith("docs:"))
    .map((page) => [new URL(page.path, "https://docs.invalid").pathname, page.id.slice("docs:".length)]));
  return text.replace(/\]\((\/docs[^\s)]*)\)/g, (match, href) => {
    const url = new URL(href, "https://docs.invalid");
    const source = sources.get(url.pathname);
    if (!source) return match;
    const sourcePath = source.split("/").map(encodeURIComponent).join("/");
    return `](https://github.com/21nCo/super-functions/blob/dev/botfn/docs/content/docs/${sourcePath}${url.hash})`;
  });
}

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentOrigin = process.env.CLOUDFLARE_DOCS_DEPLOY === "1"
  ? process.env.CLOUDFLARE_DOCS_PUBLIC_ORIGIN || undefined
  : undefined;
const { artifacts, manifest, canonicalUrl } = await buildLlmsSiteArtifacts(cwd, {
  buildLlmsTxtArtifacts, buildManifest, loadDocsConfig, FsContentProvider,
}, { canonicalUrl: deploymentOrigin });
const generatedFooter = "For programmatic access, prefer the MCP server\nor the structured manifest emitted alongside this file.";
if (!artifacts.llmsFullTxt.includes(generatedFooter)) {
  throw new Error("Unexpected DocsFn llms-full footer; review the generated artifact before publishing");
}
artifacts.llmsFullTxt = artifacts.llmsFullTxt.replace(generatedFooter, "For a page index, see /docs/llms.txt.");
artifacts.llmsTxt = withSourceLinks(artifacts.llmsTxt, manifest, canonicalUrl);
artifacts.llmsFullTxt = withSourceLinks(artifacts.llmsFullTxt, manifest, canonicalUrl);
writeLlmsArtifacts(resolve(cwd, "static"), artifacts);
