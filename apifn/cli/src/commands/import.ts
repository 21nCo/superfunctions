import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { openAPIToCollection, writeCollection } from "@apifn/collections";
import { parseOpenAPI } from "@apifn/core";
import type { Output } from "../utils/output.js";

export interface ImportOpenApiCommandOptions {
  source: string;
  outputDir: string;
  baseUrl?: string;
  env?: string;
  groupBy?: "tag" | "path";
  force?: boolean;
  cwd?: string;
  output: Output;
}

export async function runImportOpenApiCommand(options: ImportOpenApiCommandOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const outputDir = path.resolve(cwd, options.outputDir);

  try {
    if (existsSync(outputDir) && !options.force) {
      const entries = await readdir(outputDir);
      if (entries.length > 0) {
        options.output.error(`Output directory '${outputDir}' already exists. Use --force to overwrite collection files.`);
        return 2;
      }
    }

    const raw = await readSource(options.source, cwd);
    const document = parseOpenAPI(raw);
    const collection = openAPIToCollection(document, {
      baseUrl: options.baseUrl,
      environmentName: options.env ?? "development",
      groupBy: options.groupBy ?? "tag",
    });
    collection.rootDir = outputDir;

    await writeCollection(collection);
    options.output.success(`Imported OpenAPI collection to ${outputDir}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.output.error(`Failed to import OpenAPI collection: ${message}`);
    return 2;
  }
}

async function readSource(source: string, cwd: string): Promise<string> {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while reading ${source}`);
    }
    return response.text();
  }

  return readFile(path.resolve(cwd, source), "utf8");
}
