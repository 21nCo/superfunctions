import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as toYaml } from "yaml";
import { fromRouter } from "@apifn/core";
import type { OpenAPIDocument } from "@apifn/core";
import type { ApifnConfig } from "../config.js";
import { loadRouter } from "../utils/router-loader.js";
import type { Output } from "../utils/output.js";

/** Resolves the spec path `apifn generate` writes and `apifn check` reads. */
export function resolveSpecPath(options: {
  specPath?: string;
  cwd: string;
  config: ApifnConfig;
}): string {
  return options.specPath
    ? path.resolve(options.cwd, options.specPath)
    : path.resolve(options.cwd, options.config.output ?? ".apifn", "openapi.yml");
}

/** Serializes a generated document exactly as `apifn generate` writes it. */
export function serializeSpec(doc: OpenAPIDocument): string {
  return toYaml(doc);
}

/**
 * Loads the router and builds its OpenAPI document in memory. `apifn generate` and
 * `apifn check` both use this, so they produce the same document.
 */
export async function buildSpecFromRouter(options: {
  routerPath?: string;
  cwd: string;
  config: ApifnConfig;
}): Promise<{ doc: OpenAPIDocument; routeCount: number }> {
  const routerPath = options.routerPath ?? options.config.router;

  if (!routerPath) {
    throw new Error("Router path is required. Pass [router-path] or set config.router.");
  }

  const router = await loadRouter(routerPath, options.cwd);
  const routes = router.getRoutes();

  const configuredInfo = options.config.openapi?.info;
  const doc = fromRouter(router, {
    info: {
      title: "API",
      version: "1.0.0",
      ...configuredInfo,
    },
    servers: options.config.openapi?.servers,
  });

  return { doc, routeCount: routes.length };
}

export async function runGenerateCommand(options: {
  routerPath?: string;
  outputPath?: string;
  cwd?: string;
  config: ApifnConfig;
  output: Output;
}): Promise<{ routeCount: number; outputPath: string }> {
  const cwd = options.cwd ?? process.cwd();
  const { doc, routeCount } = await buildSpecFromRouter({
    routerPath: options.routerPath,
    cwd,
    config: options.config,
  });

  const outputPath = resolveSpecPath({ specPath: options.outputPath, cwd, config: options.config });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializeSpec(doc), "utf8");

  options.output.success(`Generated OpenAPI for ${routeCount} routes -> ${outputPath}`);

  return {
    routeCount,
    outputPath,
  };
}
