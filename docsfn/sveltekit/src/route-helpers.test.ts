import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildManifest, loadDocsConfig, type DocsManifest } from "../../core/src/index";
import { FsContentProvider } from "../../provider-fs/src/index";
import {
  generateStaticParams as generateNextStaticParams,
  resolveDocsPageSurface as resolveNextDocsPageSurface,
  resolveDocsRouteDataOrThrow as resolveNextDocsRouteDataOrThrow,
} from "../../next/src/route-helpers";
import {
  createPageLoad,
  generateStaticParams,
  resolveDocsPageSurface,
  resolveDocsRouteDataOrThrow,
} from "./route-helpers";

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirectory = path.dirname(thisFilePath);
const canonicalFixtureRoot = path.resolve(
  thisDirectory,
  "../../test-fixtures/repo/searchfn-docs"
);

let manifestPromise: Promise<DocsManifest> | null = null;

async function loadCanonicalManifest(): Promise<DocsManifest> {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const config = await loadDocsConfig({
        cwd: canonicalFixtureRoot,
      });

      const provider = new FsContentProvider({
        root: canonicalFixtureRoot,
      });

      return buildManifest(provider, config);
    })();
  }

  return manifestPromise;
}

describe("sveltekit route helper parity", () => {
  it("matches Next docs route resolution for root and nested slugs (TV-ROUTE-001)", async () => {
    const manifest = await loadCanonicalManifest();
    const cases: Array<string | string[] | undefined> = [
      undefined,
      "reference/client",
      ["reference", "client"],
    ];

    for (const slug of cases) {
      const nextEntry = resolveNextDocsRouteDataOrThrow(slug, manifest, {
        basePath: "/docs",
      });
      const svelteEntry = resolveDocsRouteDataOrThrow(slug, manifest, {
        basePath: "/docs",
      });

      expect(svelteEntry.kind).toBe(nextEntry.kind);
      expect(svelteEntry.route).toBe(nextEntry.route);
      if (svelteEntry.kind === "page" && nextEntry.kind === "page") {
        expect(svelteEntry.page.title).toBe(nextEntry.page.title);
      }
    }
  });

  it("matches Next static-param semantics for canonical fixture routes (TV-SVELTE-001)", async () => {
    const manifest = await loadCanonicalManifest();

    const nextParams = generateNextStaticParams(manifest, {
      basePath: "/docs",
      includeApiRoutes: true,
    });
    const svelteParams = generateStaticParams(manifest, {
      basePath: "/docs",
      includeApiRoutes: true,
    });

    const normalizedNext = nextParams.map((param) =>
      param.slug && param.slug.length > 0 ? { slug: param.slug.join("/") } : {}
    );

    expect(svelteParams).toEqual(normalizedNext);
    expect(svelteParams[0]).toEqual({});
  });

  it("derives page surface metadata with parity to Next helper output (TV-PAGE-001 + TV-NAV-001)", async () => {
    const manifest = await loadCanonicalManifest();
    const route = "/docs/reference/client";
    const entry = resolveDocsRouteDataOrThrow("reference/client", manifest, {
      basePath: "/docs",
    });

    if (entry.kind !== "page") {
      throw new Error(`expected page route entry for ${route}`);
    }

    const nextSurface = resolveNextDocsPageSurface({
      manifest,
      route,
      page: entry.page,
      options: {
        basePath: "/docs",
        homeHref: "/docs",
        versionMode: "path-prefix",
      },
    });

    const svelteSurface = resolveDocsPageSurface({
      manifest,
      route,
      page: entry.page,
      options: {
        basePath: "/docs",
        homeHref: "/docs",
        versionMode: "path-prefix",
      },
    });

    expect(svelteSurface.breadcrumbs).toEqual(nextSurface.breadcrumbs);
    expect(svelteSurface.pagination).toEqual(nextSurface.pagination);
    expect(svelteSurface.topNav).toEqual(nextSurface.topNav);
    expect(svelteSurface.canonicalPath).toBe(nextSurface.canonicalPath);
  });

  it("createPageLoad resolves root route when params.slug is undefined", async () => {
    const manifest = await loadCanonicalManifest();
    const load = createPageLoad(manifest, {
      basePath: "/docs",
      homeHref: "/docs",
    });

    const data = load({
      params: {},
    } as never);

    expect(data.route).toBe("/docs");
    expect(data.page.path).toBe("/docs");
    expect(data.surface.route).toBe("/docs");
  });
});
