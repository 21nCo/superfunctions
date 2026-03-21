import path from "node:path";
import {
  buildManifest,
  buildSearchIndex,
  loadDocsConfig,
  type DocsCompatPreset,
  type DocsManifest,
  type DocsSearchArtifact,
} from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";
import type { LayoutServerLoad } from "./$types";

export interface DocsSiteSource {
  fixtureRoot: string;
  manifest: DocsManifest;
  searchArtifact: DocsSearchArtifact;
  siteTitle: string;
  canonicalUrl?: string;
  compatPreset: DocsCompatPreset;
}

const defaultFixtureRoot = path.resolve(
  process.cwd(),
  "../../test-fixtures/repo/searchfn-docs"
);

let sourcePromise: Promise<DocsSiteSource> | null = null;

function resolveFixtureRoot(): string {
  const override = process.env.DOCSFN_FIXTURE_ROOT;
  if (override && override.trim().length > 0) {
    return path.resolve(process.cwd(), override);
  }
  return defaultFixtureRoot;
}

async function loadDocsSiteSource(): Promise<DocsSiteSource> {
  if (!sourcePromise) {
    sourcePromise = (async () => {
      const fixtureRoot = resolveFixtureRoot();
      const config = await loadDocsConfig({
        cwd: fixtureRoot,
      });
      const provider = new FsContentProvider({
        root: fixtureRoot,
      });
      const manifest = await buildManifest(provider, config);
      const searchArtifact = await buildSearchIndex(manifest, {
        search: config.search,
      });

      return {
        fixtureRoot,
        manifest,
        searchArtifact,
        siteTitle: config.site.title,
        canonicalUrl: config.site.canonicalUrl,
        compatPreset: config.compat?.preset ?? "none",
      };
    })();
  }

  return sourcePromise;
}

export const load: LayoutServerLoad = async () => {
  return {
    source: await loadDocsSiteSource(),
  };
};
