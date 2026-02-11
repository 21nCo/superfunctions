import type { Command } from "commander";
import { post } from "../http/client.js";

export function registerDocCommands(program: Command): void {
  const doc = program.command("doc").description("Document operations");

  doc
    .command("get")
    .description("Get a document from a dataset")
    .requiredOption("--dataset <name>", "Dataset name")
    .requiredOption("--id <id>", "Document ID")
    .option("--perspective <perspective>", "Perspective: published, draft, or raw", "published")
    .action(async (opts: { dataset: string; id: string; perspective: string }) => {
      const serverUrl = program.opts().server as string;
      try {
        const resp = await post(serverUrl, "/contentfn/docs/get", {
          dataset: opts.dataset,
          id: opts.id,
          perspective: opts.perspective,
        }) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };

        if (!resp.ok) {
          console.error(`Error: ${resp.error?.message ?? "Unknown error"}`);
          process.exit(1);
        }
        console.log(JSON.stringify(resp.result, null, 2));
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}
