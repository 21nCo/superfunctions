import { writeFileSync } from "fs";
import { withConfig } from "../config.js";
import { compFn } from "compfn";

export async function exportCommand(options: {
  frameworkId?: string;
  output?: string;
  config?: string;
}): Promise<void> {
  return withConfig(options.config, async (config) => {
    const api = compFn(config);

    const exportResult = await api.export.auditorPack({
      frameworkId: options.frameworkId,
    });

    if (!exportResult.ok) {
      console.error(`Error exporting auditor pack: ${exportResult.error.message}`);
      process.exitCode = 1;
      return;
    }

    const json = JSON.stringify(exportResult.result, null, 2);

    if (options.output) {
      writeFileSync(options.output, json, "utf-8");
      console.log(`Auditor pack exported to ${options.output}`);
    } else {
      console.log(json);
    }

    return;
  });
}
