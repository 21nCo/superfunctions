import { withConfig } from "../config.js";
import { compFn, createSchemaIfSupported } from "compfn";

export async function initCommand(options: { config?: string }): Promise<void> {
  return withConfig(options.config, async (config) => {

    const result = await createSchemaIfSupported(config.database, {
      namespace: config.namespace,
    });

    if (!result.success) {
      console.error("Schema creation/migration failed:");
      result.errors?.forEach((err) => console.error(`  - ${err}`));
      process.exitCode = 1;
      return;
    }

    console.log("CompFn initialized successfully.");
    return;
  });
}
