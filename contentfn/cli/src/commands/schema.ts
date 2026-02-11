import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { validateSchema } from "@contentfn/core";
import type { ContentfnSchema } from "@contentfn/core";
import { post } from "../http/client.js";

function normalizeSchema(schema: ContentfnSchema): ContentfnSchema {
  const documentTypes = [...schema.documentTypes].sort((a, b) =>
    a.name.localeCompare(b.name, "en")
  );
  return {
    version: schema.version,
    documentTypes: documentTypes.map((dt) => ({
      name: dt.name,
      fields: [...dt.fields].sort((a, b) => a.name.localeCompare(b.name, "en")).map((f) => ({
        name: f.name,
        type: f.type,
        required: f.required,
        validation: f.validation,
      })),
      meta: dt.meta,
    })),
  };
}

function computeSchemaHash(schema: ContentfnSchema): string {
  const normalized = normalizeSchema(schema);
  const canonical = JSON.stringify(normalized);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function readSchemaFile(filePath: string): unknown {
  const abs = resolve(filePath);
  const raw = readFileSync(abs, "utf8");
  return JSON.parse(raw);
}

export function registerSchemaCommands(program: Command): void {
  const schema = program.command("schema").description("Schema operations");

  schema
    .command("validate")
    .description("Validate a schema JSON file locally")
    .argument("<file>", "Path to schema JSON file")
    .action((file: string) => {
      let parsed: unknown;
      try {
        parsed = readSchemaFile(file);
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }

      const result = validateSchema(parsed);
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        if (result.error.details.path) {
          console.error(`  path: ${result.error.details.path}`);
        }
        process.exit(1);
      }

      const hash = computeSchemaHash(result.result);
      console.log(`ok ${hash}`);
    });

  schema
    .command("upsert")
    .description("Upsert schema to a running ContentFn server")
    .requiredOption("--dataset <name>", "Dataset name")
    .requiredOption("--file <file>", "Path to schema JSON file")
    .action(async (opts: { dataset: string; file: string }) => {
      const serverUrl = program.opts().server as string;
      let parsed: unknown;
      try {
        parsed = readSchemaFile(opts.file);
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }

      try {
        const resp = await post(serverUrl, "/contentfn/schema/upsert", {
          dataset: opts.dataset,
          schema: parsed,
        }) as { ok: boolean; result?: { schemaHash: string }; error?: { code: string; message: string } };

        if (!resp.ok) {
          console.error(`Error: ${resp.error?.message ?? "Unknown error"}`);
          process.exit(1);
        }
        console.log(`ok ${resp.result?.schemaHash}`);
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}
