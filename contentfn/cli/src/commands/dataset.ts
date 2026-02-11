import type { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { post } from "../http/client.js";

export function registerDatasetCommands(program: Command): void {
  const dataset = program.command("dataset").description("Dataset operations");

  dataset
    .command("export")
    .description("Export a dataset to a JSON file")
    .requiredOption("--dataset <name>", "Dataset name")
    .requiredOption("--out <file>", "Output file path")
    .action(async (opts: { dataset: string; out: string }) => {
      const serverUrl = program.opts().server as string;
      try {
        const resp = await post(serverUrl, "/contentfn/datasets/export", {
          dataset: opts.dataset,
        }) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };

        if (!resp.ok) {
          console.error(`Error: ${resp.error?.message ?? "Unknown error"}`);
          process.exit(1);
        }
        const outPath = resolve(opts.out);
        writeFileSync(outPath, JSON.stringify(resp.result, null, 2), "utf8");
        console.log(`ok exported to ${outPath}`);
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  dataset
    .command("import")
    .description("Import a dataset from a JSON file")
    .requiredOption("--dataset <name>", "Dataset name")
    .requiredOption("--in <file>", "Input file path")
    .action(async (opts: { dataset: string; in: string }) => {
      const serverUrl = program.opts().server as string;
      let artifact: unknown;
      try {
        const raw = readFileSync(resolve(opts.in), "utf8");
        artifact = JSON.parse(raw);
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }

      try {
        const resp = await post(serverUrl, "/contentfn/datasets/import", {
          dataset: opts.dataset,
          artifact,
        }) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };

        if (!resp.ok) {
          console.error(`Error: ${resp.error?.message ?? "Unknown error"}`);
          process.exit(1);
        }
        console.log(`ok imported into ${opts.dataset}`);
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}
