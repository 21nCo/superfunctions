import { loadConfig } from "../config.js";
import { compFn, createSchemaIfSupported } from "@superfunctions/compfn";

export async function initCommand(options: { config?: string }): Promise<void> {
  try {
    const config = await loadConfig(options.config);
    
    const result = await createSchemaIfSupported(config.database, {
      namespace: config.namespace,
    });

    if (!result.success) {
      console.error("Schema creation/migration failed:");
      result.errors?.forEach((err) => console.error(`  - ${err}`));
      process.exit(1);
    }

    console.log("CompFn initialized successfully.");
    process.exit(0);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
