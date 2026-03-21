import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildManifest,
  buildSearchIndex,
  loadDocsConfig,
  type DocsCompatPreset,
  type DocsManifest,
  type DocsSearchArtifact,
} from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";

export interface DocsSiteSource {
  fixtureRoot: string;
  manifest: DocsManifest;
  searchArtifact: DocsSearchArtifact;
  siteTitle: string;
  canonicalUrl?: string;
  compatPreset: DocsCompatPreset;
}

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirectory = path.dirname(thisFilePath);
const DEFAULT_FIXTURE_ROOT = path.resolve(
  thisDirectory,
  "../../test-fixtures/repo/searchfn-docs"
);

let sourcePromise: Promise<DocsSiteSource> | null = null;

function resolveFixtureRoot(): string {
  const override = process.env.DOCSFN_FIXTURE_ROOT;
  if (override && override.trim().length > 0) {
    return path.resolve(thisDirectory, override);
  }
  return DEFAULT_FIXTURE_ROOT;
}

export async function loadDocsSiteSource(): Promise<DocsSiteSource> {
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
