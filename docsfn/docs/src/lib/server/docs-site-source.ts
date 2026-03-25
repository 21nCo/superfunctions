import path from "node:path";
import {
  buildManifest,
  buildSearchIndex,
  loadDocsConfig,
  type DocsCompatPreset,
  type DocsConfig,
  type DocsManifest,
  type DocsSearchArtifact,
} from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";

export interface DocsSiteSource {
  siteRoot: string;
  manifest: DocsManifest;
  searchArtifact: DocsSearchArtifact;
  siteTitle: string;
  canonicalUrl?: string;
  compatPreset: DocsCompatPreset;
  config: DocsConfig;
}

let sourcePromise: Promise<DocsSiteSource> | null = null;

export async function loadDocsSiteSource(): Promise<DocsSiteSource> {
  if (!sourcePromise) {
    sourcePromise = (async () => {
      const siteRoot = path.resolve(process.cwd());
      const config = await loadDocsConfig({ cwd: siteRoot });
      const provider = new FsContentProvider({
        root: siteRoot,
        docsDir: config.content.docsDir,
        pagesDir: config.content.pagesDir,
        blogDir: config.content.blogDir,
        apiDir: config.content.apiDir,
        assetsDir: config.content.assetsDir,
      });
      const manifest = await buildManifest(provider, config);
      const searchArtifact = await buildSearchIndex(manifest, {
        search: config.search,
        auth: config.auth,
      });

      return {
        siteRoot,
        manifest,
        searchArtifact,
        siteTitle: config.site.title,
        canonicalUrl: config.site.canonicalUrl,
        compatPreset: config.compat?.preset ?? "none",
        config,
      };
    })();
  }

  return sourcePromise;
}
