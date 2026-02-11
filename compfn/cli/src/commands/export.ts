import { writeFileSync } from "fs";
import { loadConfig } from "../config.js";
import { compFn } from "@superfunctions/compfn";

export async function exportCommand(options: {
  frameworkId?: string;
  output?: string;
  config?: string;
}): Promise<void> {
  try {
    const config = await loadConfig(options.config);
    const api = compFn(config);

    const exportResult = await api.export.auditorPack({
      frameworkId: options.frameworkId,
    });

    if (!exportResult.ok) {
      console.error(`Error exporting auditor pack: ${exportResult.error.message}`);
      process.exit(1);
    }

    const json = JSON.stringify(exportResult.result, null, 2);

    if (options.output) {
      writeFileSync(options.output, json, "utf-8");
      console.log(`Auditor pack exported to ${options.output}`);
    } else {
      console.log(json);
    }

    process.exit(0);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
